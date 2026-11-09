const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {create}=require('../src/source-usage.js');
function environment(initial){
  let stored=initial,day='2026-11-09',fail=false;
  const options={IOUtils:{async exists(){return stored!==undefined;},async readUTF8(){return stored;},async makeDirectory(){},async writeUTF8(_path,value){if(fail)throw Error('disk full');stored=value;}},path:'/test/usage.json',directory:'/test',digest:async bytes=>createHash('sha256').update(bytes).digest('hex'),now:()=>new Date(day+'T12:00:00Z')};
  return{make:()=>create(options),get value(){return stored;},set day(value){day=value;},set fail(value){fail=value;}};
}
test('OpenAlex reservations are atomic, persistent, per-key and reset only at UTC day change',async()=>{
  const env=environment(),usage=env.make(),request={provider:'openalex',key:'fictional-key-a',limit:2};
  const results=await Promise.all(Array.from({length:8},()=>usage.reserve(request)));
  assert.equal(results.filter(Boolean).length,2);assert(!env.value.includes('fictional-key-a'));
  assert.equal(await env.make().reserve(request),false);
  assert.equal(await usage.reserve({...request,key:'fictional-key-b'}),true);
  env.day='2026-11-10';assert.equal(await env.make().reserve(request),true);
});
test('unreadable or malformed quota data fails closed and preserves original bytes',async()=>{
  for(const data of ['broken','{"schemaVersion":2,"days":{}}','{"schemaVersion":1,"days":{"today":{}}}']){
    const env=environment(data);assert.equal(await env.make().reserve({provider:'openalex',key:'fixture',limit:100}),false);assert.equal(env.value,data);
  }
  const env=environment();env.fail=true;assert.equal(await env.make().reserve({provider:'openalex',key:'fixture',limit:100}),false);assert.equal(env.value,undefined);
});
test('invalid reservation settings never spend or overwrite accounting',async()=>{
  const env=environment(),usage=env.make();
  for(const value of [{provider:'unknown',key:'x',limit:1},{provider:'openalex',key:'',limit:1},{provider:'openalex',key:'x',limit:0},{provider:'openalex',key:'x',limit:1.5}])assert.equal(await usage.reserve(value),false);
  assert.equal(env.value,undefined);
});

test('CORE uses an independent durable bucket even when a provider key string happens to be shared',async()=>{
  const env=environment(),usage=env.make(),key='shared-private-fixture';
  assert.equal(await usage.reserve({provider:'openalex',key,limit:1}),true);
  assert.equal(await usage.reserve({provider:'core',key,limit:2}),true);
  assert.equal(await usage.reserve({provider:'core',key,limit:2}),true);
  assert.equal(await env.make().reserve({provider:'core',key,limit:2}),false);
  assert.equal(await env.make().reserve({provider:'openalex',key,limit:1}),false);
  assert.equal(Object.keys(JSON.parse(env.value).days['2026-11-09']).length,2);
  assert(!env.value.includes(key));assert(!env.value.includes('core'));
});

test('CORE simultaneous and failed download reservations cannot exceed allowance or undo the persisted attempt',async()=>{
  const env=environment(),usage=env.make(),request={provider:'core',key:'core-private-fixture',limit:3};
  const result=await Promise.all(Array.from({length:12},()=>usage.reserve(request)));
  assert.equal(result.filter(Boolean).length,3);
  // There is deliberately no refund on transport failure: a new instance sees
  // the same exhausted local attempt counter before it may request another PDF.
  assert.equal(await env.make().reserve(request),false);
  env.day='2026-11-10';assert.equal(await env.make().reserve(request),true);
  const damaged=environment('{"schemaVersion":2,"days":{}}');
  assert.equal(await damaged.make().reserve(request),false);assert.equal(damaged.value,'{"schemaVersion":2,"days":{}}');
});
