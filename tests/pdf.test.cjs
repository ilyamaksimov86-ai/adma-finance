const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {stripTypeScriptTypes} = require('node:module');
const {PDFDocument, PDFString, PDFName, rgb} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const raw=readFileSync('supabase/functions/reimbursement-pdf/index.ts','utf8').replace(/^import .*;\s*$/gm,'');
const {makePdf,withReceiptLinks} = new Function('PDFDocument','PDFString','rgb','fontkit','Deno',stripTypeScriptTypes(raw)+'\nreturn {makePdf,withReceiptLinks};')(PDFDocument,PDFString,rgb,fontkit,{serve(){}});
const project=new Map([['p1',{name:'ЖК Тестовый объект'}]]);
const expense={id:'e1',project_id:'p1',amount:1250,expense_date:'2026-09-05',supplier:'Петрович',category:'Материалы',comment:'Проверка русского текста',receipt_path:'test/receipt.jpg'};
test('actual PDF generator produces a readable Cyrillic document',async()=>{
 const bytes=await makePdf([expense],project);
 assert.equal(Buffer.from(bytes).subarray(0,4).toString(),'%PDF');
 const pdf=await PDFDocument.load(bytes);
 assert.equal(pdf.getPageCount(),1);assert.match(pdf.getTitle(),/расходы/);
});
test('actual PDF generator paginates a large reimbursement list',async()=>{
 const bytes=await makePdf(Array.from({length:80},(_,i)=>({...expense,id:'e'+i})),project);
 const pdf=await PDFDocument.load(bytes);assert(pdf.getPageCount()>1);
});

function links(pdf) {
 return pdf.getPages().flatMap(page => (page.node.Annots()?.asArray() || []).map(ref => {
  const annotation=pdf.context.lookup(ref), action=annotation.lookup(PDFName.of('A'));
  assert.equal(annotation.get(PDFName.of('Subtype')).toString(),'/Link');
  assert.equal(action.get(PDFName.of('S')).toString(),'/URI');
  const rect=annotation.lookup(PDFName.of('Rect')).asArray().map(n=>n.asNumber());
  assert(rect[0]>=36 && rect[2]<=page.getWidth()-36 && rect[1]>36 && rect[3]<page.getHeight()-36);
  return action.get(PDFName.of('URI')).decodeText();
 }));
}
test('receipt links use the private bucket, seven days, and only supplied expense paths',async()=>{
 let calls=0;
 const db={storage:{from(bucket){assert.equal(bucket,'receipts');return {async createSignedUrls(paths,ttl){
  calls++;assert.deepEqual(paths,['test/receipt.jpg','missing.jpg']);assert.equal(ttl,604800);
  return {data:[{path:'missing.jpg',error:'Object not found',signedUrl:null},{path:'test/receipt.jpg',signedUrl:'https://example.test/storage/v1/object/sign/receipts/test/receipt.jpg?token=test'}],error:null};
 }}}}};
 const original=[expense,{...expense,id:'e2'},{...expense,id:'e3',receipt_path:null},{...expense,id:'e4',receipt_path:'missing.jpg'}];
 const result=await withReceiptLinks(db,original);
 assert.equal(calls,1);assert.equal(result[0].receipt_url,result[1].receipt_url);
 assert.equal(result[2].receipt_url,null);assert.equal(result[3].receipt_url,null);
 assert.equal(original[0].receipt_url,undefined);
 const pdf=await PDFDocument.load(await makePdf(result,project));
 assert.deepEqual(links(pdf),[result[0].receipt_url,result[1].receipt_url]);
});
test('no receipts need no Storage call; signing outage does not silently drop all links',async()=>{
 assert.equal((await withReceiptLinks({},[{...expense,receipt_path:null}]))[0].receipt_url,null);
 await assert.rejects(withReceiptLinks({storage:{from(){return {async createSignedUrls(){return {error:new Error('offline')}}}}}},[expense]),/receipt_links_unavailable/);
});
test('long descriptions and page breaks preserve every clickable receipt link',async()=>{
 const expenses=Array.from({length:80},(_,i)=>({...expense,id:'e'+i,comment:'Очень длинное описание '.repeat(30),receipt_url:'https://example.test/storage/v1/object/sign/receipts/'+i+'.jpg?token=test'}));
 const bytes=await makePdf(expenses,project),pdf=await PDFDocument.load(bytes);
 assert(pdf.getPageCount()>1);assert.deepEqual(links(pdf),expenses.map(e=>e.receipt_url));
 if(process.env.PDF_PREVIEW)require('node:fs').writeFileSync(process.env.PDF_PREVIEW,bytes);
});
