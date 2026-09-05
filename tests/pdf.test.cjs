const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {stripTypeScriptTypes} = require('node:module');
const {PDFDocument, rgb} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const raw=readFileSync('supabase/functions/reimbursement-pdf/index.ts','utf8').replace(/^import .*;\s*$/gm,'');
const makePdf = new Function('PDFDocument','rgb','fontkit','Deno',stripTypeScriptTypes(raw)+'\nreturn makePdf;')(PDFDocument,rgb,fontkit,{serve(){}});
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
