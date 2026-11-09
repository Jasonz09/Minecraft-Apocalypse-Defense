"""Audit immutable named backups only. No live DB, pack, or catalog writes."""
from pathlib import Path
import json,hashlib,importlib.util,struct
ROOT=Path(__file__).resolve().parents[3]
OUT=Path(__file__).resolve().parent
helper=ROOT/'dev/staging/population-archer-readiness/closed-fixture-preflight-v2.py'
sp=importlib.util.spec_from_file_location('closed_preflight',helper);m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
parser=m.parser_definitions()
H=lambda b:hashlib.sha256(b).hexdigest().upper()
def read_json(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def pinned_receipt(name):
 p=ROOT/name;r=read_json(p);assert r['closed'] is True;b=Path(r['backup']).resolve();assert b.is_relative_to((ROOT/'dist/backups').resolve())
 files=m.inventory(b);expected={f['path']:{'bytes':f['bytes'],'sha256':f['sha256']}for f in r['files']};assert files==expected and len(files)==r['fileCount']
 return p,r,b,files
sourcep,source,backup,before=pinned_receipt('dist/vanilla-cavalry-pad-prepared-20261108.json')
origp,orig,pristine,origfiles=pinned_receipt('dist/vanilla-never-owner-backup-20261108.json')
clonep=ROOT/'dist/vanilla-cavalry-pad-clone-20261108.json';clone=read_json(clonep)
assert Path(clone['source']).resolve()==pristine and Path(clone['destination']).resolve()==Path(source['source']).resolve()
clonefiles={f['path']:{'bytes':f['bytes'],'sha256':f['sha256']}for f in clone['files']}
assert len(clonefiles)==9 and set(clonefiles)==set(origfiles)
assert [k for k in origfiles if origfiles[k]!=clonefiles[k]]==['level.dat','levelname.txt']
# Decode CRC-framed manifest version edits; no SST/chunk decoding.
def version_edit(data):
 i=0;out=[]
 def num():
  nonlocal i
  n,i=parser['varint'](data,i);return n
 def text():
  nonlocal i
  n=num();v=data[i:i+n];i+=n;assert len(v)==n;return v
 while i<len(data):
  tag=num();row={'tag':tag}
  if tag==1:row['comparator']=text().decode('ascii')
  elif tag in [2,3,4,9]:row['value']=num()
  elif tag==5:row.update(level=num(),key=text().hex())
  elif tag==6:row.update(level=num(),file=num())
  elif tag==7:row.update(level=num(),file=num(),bytes=num(),smallest=text().hex(),largest=text().hex())
  else:raise ValueError('unsupported version edit tag '+str(tag))
  out.append(row)
 assert i==len(data);return out
manifest=(backup/'db/CURRENT').read_text(encoding='ascii').strip();assert manifest=='MANIFEST-000004'
edits=[version_edit(r)for r in m.strict_records((backup/'db'/manifest).read_bytes(),parser)]
flat=[row for edit in edits for row in edit]
assert next(row['value']for row in flat if row['tag']==4)==465
assert next(row['value']for row in flat if row['tag']==2)==6
sst=[row for row in flat if row['tag']==7];assert len(sst)==1 and sst[0]['file']==5 and sst[0]['bytes']==before['db/000005.ldb']['bytes']
allrows=[];wal_reports=[]
for label,b in [('original-new-vanilla',pristine),('prepared-pad',backup)]:
 rows=[]
 for f in sorted((b/'db').glob('*.log')):
  records=list(m.strict_records(f.read_bytes(),parser))
  decoded=[entry for rec in records for entry in parser['batches'](rec)]
  rows+=decoded
  wal_reports.append({'source':label,'path':str(f),'sha256':H(f.read_bytes()),'logicalRecords':len(records),'mutations':len(decoded),'firstSequence':min(x[0]for x in decoded),'lastSequence':max(x[0]for x in decoded),'allPhysicalCrcAndFragmentPaddingVerified':True,'allBatchBytesConsumed':True})
 allrows+=rows
assert [s for s,k,v in allrows]==list(range(1,1038))
history=[];dynamics=[];scores=[]
for seq,key,value in allrows:
 if key==b'DynamicProperties':
  dynamics.append({'sequence':seq,'deleted':value is None})
  if value is not None:
   _,tree=parser['NBT'](value).root()
   for path,node in m.tree_rows(tree):
    if isinstance(node,dict) and any(k==m.MAIN_UUID or k.startswith(('civ:','civ_','civpop:','civbirth:'))for k in node):history.append({'sequence':seq,'path':path})
 if key==b'scoreboard' and value is not None:
  _,tree=parser['NBT'](value).root();scores.append({'sequence':seq,'rawSha256':H(value),'bytes':len(value),'tree':tree})
assert not history and not dynamics
current=scores[-1];score=current['tree'];assert current['sequence']==982
assert set(score)=={'Criteria','DisplayObjectives','Entries','LastUniqueID','Objectives'} and score['Criteria']==[] and score['DisplayObjectives']==[] and score['LastUniqueID']==1
assert score['Entries']==[{'FakePlayerName':'NEVER_PEOPLE_ON','IdentityType':3,'ScoreboardId':1}]
assert score['Objectives']==[{'Criteria':'dummy','DisplayName':'CA_FRESH_8e17b80d8dc644d3','Name':'ca_fresh_owner','Scores':[{'Score':0,'ScoreboardId':1}]}]
originalscore=read_json(ROOT/'dev/staging/population-archer-readiness/native-evidence/exact-scoreboard-identity-audit-20261108.json')
assert current['rawSha256']==originalscore['exactScoreboard']['latestRawSha256']
levelraw=(backup/'level.dat').read_bytes();assert struct.unpack_from('<i',levelraw,4)[0]==len(levelraw)-8
_,level=parser['NBT'](levelraw[8:]).root();assert level['LevelName']==clone['visibleName'];assert level['Difficulty']==0 and level['domobspawning']==0
bindings={name:read_json(backup/name)for name in ['world_behavior_packs.json','world_resource_packs.json']};assert all(v==[]for v in bindings.values())
assert source['peopleEnabled'] is False
logp=Path.home()/'AppData/Roaming/Minecraft Bedrock/logs/ContentLog2026-11-08_19-37-23_1.txt';logbytes=logp.read_bytes();log=logbytes.decode('utf-8-sig');lower=log.lower()
logreport={'path':str(logp),'copiedWholeFile':True,'bytes':len(logbytes),'sha256':H(logbytes),'errors':lower.count('[error]'),'warnings':lower.count('[warning]'),'highMemoryWarnings':lower.count('high memory'),'exceptions':lower.count('exception'),'verboseSoundMessages':lower.count('[sound][verbose]'),'message':'No sound found for block type normal and event fly is verbose, not warning/error.'}
assert all(logreport[k]==0 for k in ['errors','warnings','highMemoryWarnings','exceptions'])
assert m.inventory(backup)==before and m.inventory(pristine)==origfiles
report={'decision':'CLOSED_PAD_CHAIN_AND_EXACT_MARKER_VERIFIED_FOR_ROOT_REVIEW; no trust compiled or activation performed','sourceReceiptSha256':H(sourcep.read_bytes()),'noMainHistory':True,'noAttachedPacks':True,'neverPeopleOn':True,'booleanMeaning':'Known operator-witnessed pristine creation and exact clone plus complete observed sequence1..1037 chain; not an inference from current absence alone, not universal history or SST/entity census proof. Root must independently approve ROOT-WITNESS.','scope':'Read-only immutable prepared10-file backup and pristine9-file backup; clone receipt and whole closed log. No live world/DB/UI/native chunk reads.','sourceReceipt':{'path':str(sourcep.relative_to(ROOT)),'sha256':H(sourcep.read_bytes()),'files':10,'allPinsMatch':True},'originalReceipt':{'path':str(origp.relative_to(ROOT)),'sha256':H(origp.read_bytes()),'files':9,'allPinsMatch':True,'operatorWitness':'Root witnessed genuine new vanilla Creative/cheats creation with no BP/RP; initial no-people-on marker. This is operator evidence, not machine reconstruction of arbitrary prior history.'},'cloneReceipt':{'path':str(clonep.relative_to(ROOT)),'sha256':H(clonep.read_bytes()),'onlyInitialChanges':['level.dat','levelname.txt'],'dbAndAllOtherOriginalBytesExact':True},'preparedBackup':str(backup),'files':before,'level':{k:level[k]for k in ['LevelName','Difficulty','domobspawning','cheatsEnabled','commandsEnabled','hasLockedBehaviorPack','hasLockedResourcePack']},'packBindings':bindings,'storageCoverage':{'currentManifest':manifest,'crcVerifiedVersionEdits':edits,'checkpointLastSequence':465,'walReports':wal_reports,'observedMutationRange':[1,1037],'contiguousWithoutMissingOrDuplicateSequence':True,'dynamicPropertiesRecords':dynamics,'mainNamespaceHits':history,'sstFilesNotDecoded':['db/000005.ldb'],'sstSha256':before['db/000005.ldb']['sha256'],'sstBytesEqualPreviouslyObservedVanillaCheckpoint':before['db/000005.ldb']['sha256']=='B1A225BEC7A731EB30099E6AD4011B4B281AD9E0AAF02A8BF0DB37DA26D4C310'},'exactScoreboard':{'key':'scoreboard','latestSequence':current['sequence'],'latestRawSha256':current['rawSha256'],'exactRootFields':sorted(score),'objective':score['Objectives'][0],'entry':score['Entries'][0],'joinedScore':score['Objectives'][0]['Scores'][0],'participantIdFromClosedNBT':1,'rawByteIdenticalToPristine':True,'allVersions':[{'sequence':r['sequence'],'bytes':r['bytes'],'sha256':r['rawSha256']}for r in scores],'runtimeRequirement':'Existing adapter must still check actual FakePlayer type/id1 and all freshness/dev/caller/native gates after reviewed private BP bind.'},'nativePadWitness':{'provenance':'Root native UI command outcomes, not independently decoded chunk proof','commandsExecuted':11,'reported':source['nativeObserved'],'origin':{'x':8,'y':301,'z':8},'executeChecksSucceededAt':{'x':6,'y':302,'z':8},'devgateOrActivationExecuted':False,'chunkDecodePadProof':False},'closedLog':logreport,'parser':{'path':str(m.PARSER.relative_to(ROOT)),'sha256':m.PARSER_SHA,'definitionsOnly':True,'strictCrcPaddingHelper':str(helper.relative_to(ROOT)),'helperSha256':H(helper.read_bytes())},'preservation':{'all10PreparedAnd9OriginalPinsStillExactAfterAudit':True,'backupWorldsChanged':False,'trustCompiled':False,'activationPerformed':False,'installedPackChanged':False},'limitations':['SST/checkpoint contents and chunk/entity data not independently decoded. Same known checkpoint hash and contiguous original+prepared WAL support the documented witnessed clone chain; they do not establish arbitrary prior-history absence.','No machine-derived horse pad geometry, entity-free, air/floor/headroom or whole entity census proof. Native11-command root witness supplies the pad check.','Current empty pack lists alone do not prove never-attached history; root new-vanilla/clone witness plus observed full WAL chain is required.','No cavalry actors, native mounting/pathing, cleanup/death/rejoin, performance or multiplayer behavior tested by this audit.']}
for name,data in [('AUDIT.json',(json.dumps(report,indent=2)+'\n').encode()),(logp.name,logbytes)]:
 with (OUT/name).open('xb') as f:f.write(data)
print(json.dumps({'sourceReceiptSha256':report['sourceReceiptSha256'],'auditSha256':H((OUT/'AUDIT.json').read_bytes()),'mutations':len(allrows),'scoreSequence':982,'logBytes':len(logbytes),'all19PinsPreserved':True}))
