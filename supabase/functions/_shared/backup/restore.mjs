import {BACKUP_SOURCE_BUCKETS,sha256Hex,stableStringify,validateManifest} from './core.mjs';

const SOURCE_BUCKETS=new Set(BACKUP_SOURCE_BUCKETS);

function fail(code){throw new Error(code);}
function object(value,code){if(!value||typeof value!=='object'||Array.isArray(value))fail(code);return value;}
function safePath(path){if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||/[\u0000-\u001f\u007f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))fail('invalid_storage_path');return path;}
function keyFor(row,columns,code){
 const values=columns.map(column=>{
  if(!Object.hasOwn(row,column)||row[column]===null||row[column]===undefined)fail(code);
  return row[column];
 });
 return stableStringify(values);
}
function schemaShape(table){return {table_name:table.table_name,columns:table.columns,numeric_columns:table.numeric_columns,primary_key:table.primary_key,foreign_keys:table.foreign_keys};}
function mapValue(values,key){return values instanceof Map?values.get(key):values?.[key];}
async function bytesOf(value){
 if(value instanceof Uint8Array)return value;
 if(value instanceof ArrayBuffer)return new Uint8Array(value);
 if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
 if(typeof value==='string')return new TextEncoder().encode(value);
 if(value&&typeof value.arrayBuffer==='function')return new Uint8Array(await value.arrayBuffer());
 fail('invalid_restore_bytes');
}
function assertRowShape(row,table){
 object(row,'invalid_snapshot_row');
 const expected=table.columns.map(column=>column.name).sort();
 const actual=Object.keys(row).sort();
 if(stableStringify(actual)!==stableStringify(expected))fail('unknown_snapshot_column');
 for(const column of table.numeric_columns){if(row[column]!==null&&typeof row[column]!=='string')fail('numeric_precision_not_preserved');}
}
function indexRows(rows,table,prefix){
 if(!Array.isArray(rows))fail(`invalid_${prefix}_rows`);
 const result=new Map();
 for(const row of rows){
  assertRowShape(row,table);
  const key=keyFor(row,table.primary_key,`missing_${prefix}_key`);
  if(result.has(key))fail(`duplicate_${prefix}_key`);
  result.set(key,row);
 }
 return result;
}

export function topologicalTableOrder(tables){
 if(!Array.isArray(tables))fail('invalid_tables');
 const byName=new Map();
 for(const table of tables){
  if(typeof table?.table_name!=='string'||byName.has(table.table_name))fail('duplicate_table');
  byName.set(table.table_name,table);
 }
 const dependencies=new Map();
 for(const table of tables){
  const refs=new Set();
  if(!Array.isArray(table.foreign_keys))fail('invalid_foreign_keys');
  for(const fk of table.foreign_keys){
   if(!byName.has(fk.referenced_table))fail('unknown_foreign_key_table');
   refs.add(fk.referenced_table);
  }
  dependencies.set(table.table_name,refs);
 }
 const result=[];
 const remaining=new Set([...byName.keys()].sort());
 while(remaining.size){
  const ready=[...remaining].filter(name=>[...dependencies.get(name)].every(dep=>!remaining.has(dep))).sort();
  if(!ready.length)fail('foreign_key_cycle');
  for(const name of ready){remaining.delete(name);result.push(name);}
 }
 return result;
}

export function classifyRows(snapshotRows,targetRows,tableMeta){
 object(tableMeta,'invalid_table_meta');
 if(!Array.isArray(tableMeta.primary_key)||!tableMeta.primary_key.length)fail('invalid_primary_key');
 const snapshot=indexRows(snapshotRows,tableMeta,'snapshot');
 const target=indexRows(targetRows,tableMeta,'target');
 const result={insert:0,existing_identical:0,conflict:0,total:snapshot.size};
 for(const [key,row] of snapshot){
  if(!target.has(key))result.insert++;
  else if(stableStringify(row)===stableStringify(target.get(key)))result.existing_identical++;
  else result.conflict++;
 }
 return result;
}

export function classifyStorage(snapshotEntries,targetObjects){
 if(!Array.isArray(snapshotEntries)||!Array.isArray(targetObjects))fail('invalid_storage_comparison');
 const targets=new Map();
 for(const target of targetObjects){
  if(!SOURCE_BUCKETS.has(target?.bucket))fail('invalid_target_bucket');
  const key=`${target.bucket}/${safePath(target.path)}`;
  if(targets.has(key))fail('duplicate_target_storage_path');
  targets.set(key,target);
 }
 const seen=new Set();
 const result={insert:0,existing_identical:0,conflict:0,total:snapshotEntries.length};
 for(const entry of snapshotEntries){
  if(!SOURCE_BUCKETS.has(entry?.source_bucket))fail('invalid_source_bucket');
  const key=`${entry.source_bucket}/${safePath(entry.source_path)}`;
  if(seen.has(key))fail('duplicate_snapshot_storage_path');
  seen.add(key);
  const target=targets.get(key);
  if(!target)result.insert++;
  else if(target.size===entry.source_size&&target.checksum===entry.source_checksum)result.existing_identical++;
  else result.conflict++;
 }
 return result;
}

export function buildRestoreDryRun(input){
 if(input?.mode!=='dry-run')fail('dry_run_only');
 return buildRestoreDryRunAsync(input);
}

async function buildRestoreDryRunAsync(input){
 object(input,'invalid_restore_input');
 await validateManifest(input.manifest,input.expectedTables);
 const manifest=input.manifest;
 if(!Array.isArray(input.liveSchema))fail('invalid_live_schema');
 const manifestNames=manifest.database.tables.map(table=>table.table_name).sort();
 const liveNames=input.liveSchema.map(table=>table.table_name).sort();
 if(stableStringify(manifestNames)!==stableStringify(liveNames))fail('schema_drift');
 const liveByName=new Map(input.liveSchema.map(table=>[table.table_name,table]));
 for(const table of manifest.database.tables){
  const live=liveByName.get(table.table_name);
  if(!live||stableStringify(schemaShape(table))!==stableStringify(schemaShape(live)))fail('schema_drift');
 }

 const snapshotRows={};
 for(const table of manifest.database.tables){
  const rows=[];
  for(const part of table.parts){
   const raw=mapValue(input.databaseParts,part.path);
   if(raw===undefined||raw===null)fail('missing_database_part');
   const bytes=await bytesOf(raw);
   if(bytes.byteLength!==part.bytes)fail('database_part_bytes_mismatch');
   if(await sha256Hex(bytes)!==part.checksum)fail('database_part_checksum_mismatch');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   const partRows=text===''?[]:text.split('\n').map(line=>JSON.parse(line));
   if(input.databaseParts instanceof Map)input.databaseParts.delete(part.path);else delete input.databaseParts?.[part.path];
   if(partRows.length!==part.row_count)fail('database_part_row_count_mismatch');
   for(const row of partRows){assertRowShape(row,table);rows.push(row);}
  }
  if(rows.length!==table.row_count)fail('table_row_count_mismatch');
  indexRows(rows,table,'snapshot');
  snapshotRows[table.table_name]=rows;
 }

 for(const entry of manifest.storage.objects){
  const raw=mapValue(input.backupBlobs,entry.backup_blob_path);
  if(raw===undefined||raw===null)fail('missing_backup_blob');
  const bytes=await bytesOf(raw);
  if(bytes.byteLength!==entry.source_size)fail('backup_blob_size_mismatch');
  if(await sha256Hex(bytes)!==entry.backup_checksum)fail('backup_blob_checksum_mismatch');
  if(input.backupBlobs instanceof Map)input.backupBlobs.delete(entry.backup_blob_path);else delete input.backupBlobs?.[entry.backup_blob_path];
 }

 const targetRows=input.targetRows??{};
 for(const name of Object.keys(targetRows))if(!liveByName.has(name))fail('unknown_target_table');
 const targetIndexes={};
 for(const table of manifest.database.tables){
  targetIndexes[table.table_name]=indexRows(targetRows[table.table_name]??[],table,'target');
 }

 const database={insert:0,existing_identical:0,conflict:0,missing_dependency:0,total:0,tables:{}};
 const tableOrder=topologicalTableOrder(manifest.database.tables);
 const tableByName=new Map(manifest.database.tables.map(table=>[table.table_name,table]));
 const availableIndexes={};
 for(const tableName of tableOrder){
  const table=tableByName.get(tableName);
  const eligible=[];
  let missing=0;
  for(const row of snapshotRows[table.table_name]){
   let rowMissing=false;
   for(const fk of table.foreign_keys){
    if(!Array.isArray(fk.columns)||!Array.isArray(fk.referenced_columns)||fk.columns.length!==fk.referenced_columns.length||!fk.columns.length)fail('invalid_foreign_key_metadata');
    const values=fk.columns.map(column=>row[column]);
    if(values.every(value=>value===null))continue;
    if(values.some(value=>value===null)){rowMissing=true;break;}
    const parentKey=stableStringify(values);
    if(!availableIndexes[fk.referenced_table]?.has(parentKey)){rowMissing=true;break;}
   }
   if(rowMissing)missing++;else eligible.push(row);
  }
  const classified=classifyRows(eligible,targetRows[table.table_name]??[],table);
  const tableResult={...classified,missing_dependency:missing,total:snapshotRows[table.table_name].length};
  database.tables[table.table_name]=tableResult;
  for(const field of ['insert','existing_identical','conflict','missing_dependency','total'])database[field]+=tableResult[field];
  const available=new Map(targetIndexes[table.table_name]);
  for(const row of eligible)available.set(keyFor(row,table.primary_key,'missing_snapshot_key'),row);
  availableIndexes[table.table_name]=available;
 }
 const storage=classifyStorage(manifest.storage.objects,input.targetStorage??[]);
 return {mode:'dry-run',backup_id:manifest.backup_id,table_order:tableOrder,database,storage,validated_parts:manifest.database.tables.reduce((n,table)=>n+table.parts.length,0),validated_blobs:manifest.storage.objects.length};
}
