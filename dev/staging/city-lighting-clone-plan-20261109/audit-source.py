"""Closed immutable city backup only; no live world/source mutation."""
from pathlib import Path
import importlib.util,json,hashlib
ROOT=Path(__file__).resolve().parents[3];OUT=Path(__file__).resolve().parent
H=lambda b:hashlib.sha256(b).hexdigest().upper()
p=ROOT/'dev/staging/population-archer-readiness/closed-fixture-preflight-v2.py';sp=importlib.util.spec_from_file_location('closed',p);m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m);r=m.parser_definitions()
receipt=ROOT/'dist/native176-city-smoke-20261108.json';assert H(receipt.read_bytes())=='2E407D82DE7DE69837C72C817371F5E4564E69F7B673836C7A5AAE51B99A86A8'
x=json.loads(receipt.read_text(encoding='utf-8-sig'));backup=Path(x['backup']).resolve();assert backup.is_relative_to((ROOT/'dist/backups').resolve())
before=m.inventory(backup);assert before=={f['path']:{'bytes':f['bytes'],'sha256':f['sha256']}for f in x['files']}and len(before)==16
class Typed(r['NBT']):
 def payload(self,t):
  if t!=10:return super().payload(t)
  out={}
  while True:
   st=self.num('B')
   if not st:return out
   name=self.string();assert name not in out;out[name]={'tag':st,'value':self.payload(st)}
snap=[];wal=[]
for name in sorted(before):
 if not(name.startswith('db/')and name.endswith('.log')):continue
 raw=(backup/name).read_bytes();recs=list(m.strict_records(raw,r));entries=[v for rec in recs for v in r['batches'](rec)];wal.append({'path':name,'sha256':H(raw),'firstSequence':min(v[0]for v in entries),'lastSequence':max(v[0]for v in entries),'mutations':len(entries),'crcFragmentsAndPaddingVerified':True})
 for seq,key,value in entries:
  if key==b'DynamicProperties'and value is not None:
   _,tree=r['NBT'](value).root();props=tree.get(m.MAIN_UUID,tree)
   if 'civ:kingdom'in props:snap.append((seq,props,value))
seq,props,raw=max(snap,key=lambda v:v[0]);_,typed=Typed(raw).root();typed=typed[m.MAIN_UUID]['value'];gate=typed.get('civ_people');assert gate=={'tag':1,'value':1}
kingdom=json.loads(props['civ:kingdom']);cursor=json.loads(props['civ_pop']);assert cursor['v']==1
leafkeys=[k for k in props if k.startswith('civ:wall_leaf_trim:')];assert leafkeys==['civ:wall_leaf_trim:v1:d4:c835b06e'];leafraw=props[leafkeys[0]];leaf=json.loads(leafraw);assert leaf['v']==2 and leaf['complete']is True and len(leaf['entries'])==14 and all(e['done']is True for e in leaf['entries'])
historical=ROOT/'dist/native161-city-rejoin-checks-20261106.json';old=json.loads(historical.read_text(encoding='utf-8-sig'));leafwitness=next(c for c in old['checks']if c['label']=='protected3-jungle-leaf-IDs');wallchecks=[c for c in old['checks']if c['label'].startswith('repaired-masonry-')]
sourcekeys=[k for k in props if k.startswith('civ:plan:')or k.startswith('civ:jobs:')];assert len(sourcekeys)==35
rawpin=lambda k:{'key':k,'bytes':len(props[k].encode('utf-8')),'sha256':H(props[k].encode('utf-8'))}
report={'scope':'Read-only immutable closed176city backup, CRC WAL/NBT metadata only; no SST/chunk/entity decode','sourceReceipt':{'path':str(receipt),'sha256':H(receipt.read_bytes())},'backup':str(backup),'all16FilesExact':True,'inventory':before,'latestMainSnapshotSequence':seq,'mainSnapshotCount':len(snap),'rawMainNbtSha256':H(raw),'wal':wal,'kingdom':{'step':kingdom['step'],'districts':[{'id':d['id'],'status':d.get('civ',{}).get('status'),'checksum':d.get('civ',{}).get('checksum')}for d in kingdom['districts']]},'peopleGate':{'key':'civ_people','nbtTag':1,'nbtValue':1,'semantic':'ON (stored Boolean Byte1); do not confuse with numeric native1','notReadFromLiveWorld':True},'populationHistory':{'cursorKey':'civ_pop','cursorRawPin':rawpin('civ_pop'),'cursor':cursor,'previousPhysicalGroupIds':len(cursor['p']),'notActorCensus':True,'latestMainCreationOrBindingKeys':[k for k in props if k.startswith(('civ:creation_activation:','civ:pop_bind:'))],'absenceMeaning':'No such keys in this latest main snapshot; not proof of never-owned/no-history or no living actors.'},'protectedMetadata':{'planJobRawPins':[rawpin(k)for k in sorted(sourcekeys)],'wallReceiptRawPin':rawpin(leafkeys[0]),'wallReceipt':leaf,'receipt14Done':True,'protected3SeparateReceiptPresent':False,'protected3HistoricalWitness':{'path':str(historical),'sha256':H(historical.read_bytes()),'check':leafwitness,'coordinates':[{'x':-321,'y':56,'z':-456},{'x':-321,'y':56,'z':-455},{'x':-320,'y':56,'z':-456}],'expectedHistoricalId':'minecraft:jungle_leaves','notCurrentBlockOrStateProof':True},'wall14HistoricalNativeChecks':wallchecks},'rootChoice':'Root explicitly accepts ordinary population+simulation evolution on NEW CITY CLONE ONLY under reviewed ordinary NULL build; no new owner/HOLD bypass or actor lifecycle proof. No OFF/DP patch/reset/manual NPC removal/teleport/adoption commands. Preserve original16source, before/after clone receipts; lighting commands remain readonly until actual preview/protection separate gate. This is a project testing decision record, not a freshness or authorization certificate.','preservation':{'afterInventoryStillExact':m.inventory(backup)==before,'sourceOrLiveWorldChanged':False},'limitations':['Undecoded SST/chunk/entity data: DB byte preservation retains source contents, does not itself prove current3leaf IDs or14physicalmasonry cells.','Opening ordinary NULL with gateON can advance/reconcile/spawn/adopt under existing legacy owners before preview; GUI pause alone is not proven to prevent it.','People OFF is not inert and can trigger teardown; no OFF or offline gate patch is authorized by this plan.','Simulation/population evolution on disposable copy is root accepted and must not be counted as lighting cleanup. No new ownership or release/coverage proof.']}
assert report['preservation']['afterInventoryStillExact']
with(OUT/'SOURCE-AUDIT.json').open('x',encoding='utf-8')as f:json.dump(report,f,indent=2);f.write('\n')
print(json.dumps({'snapshot':seq,'gate':'Byte1 ON','cursorPhysicalIds':len(cursor['p']),'receiptDone':14,'planJobPins':35,'sourceFiles':16,'sha256':H((OUT/'SOURCE-AUDIT.json').read_bytes())}))
