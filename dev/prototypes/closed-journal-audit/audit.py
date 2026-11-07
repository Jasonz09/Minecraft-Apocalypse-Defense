"""Read only the explicitly named closed backup WAL; never open the engine DB."""
from pathlib import Path
import hashlib, json, struct

ROOT=Path(__file__).resolve().parents[3]
BACKUP=ROOT/'dist/backups/corrected-d4-kitchen-frontage-migrated-fern-held-20261105'
assert BACKUP.resolve().is_relative_to((ROOT/'dist/backups').resolve())
EXPECTED='FDA4AF3FECCE2FBE940DD50EF0A802F53983F9BA648D815504505BBF12A7CB18'
assert hashlib.sha256((BACKUP/'level.dat').read_bytes()).hexdigest().upper()==EXPECTED
file_hashes={str(p.relative_to(BACKUP)):hashlib.sha256(p.read_bytes()).hexdigest().upper() for p in sorted(BACKUP.rglob('*')) if p.is_file()}

def crc32c(data):
    crc=0xffffffff
    for byte in data:
        crc ^= byte
        for _ in range(8): crc=(crc>>1) ^ (0x82f63b78 if crc&1 else 0)
    return crc ^ 0xffffffff

def records(raw):
    pending=None
    for start in range(0,len(raw),32768):
        block=raw[start:start+32768]; i=0
        while i+7<=len(block):
            crc,n,kind=struct.unpack_from('<IHB',block,i); i+=7
            if not crc and not n and not kind: break
            assert i+n<=len(block), 'incomplete physical record'
            part=block[i:i+n];i+=n
            c=crc32c(bytes([kind])+part); masked=(((c>>15)|(c<<17))+0xa282ead8)&0xffffffff
            assert crc==masked, 'physical record CRC mismatch'
            if kind==1: assert pending is None; yield part
            elif kind==2: assert pending is None; pending=bytearray(part)
            elif kind==3: assert pending is not None; pending.extend(part)
            elif kind==4: assert pending is not None; pending.extend(part); yield bytes(pending); pending=None
            else: raise ValueError('unknown physical record type')
    assert pending is None, 'incomplete logical record'

def varint(b,i):
    value=shift=0
    while True:
        x=b[i];i+=1;value|=(x&127)<<shift
        if not x&128:return value,i
        shift+=7;assert shift<35

def batches(b):
    sequence,count=struct.unpack_from('<QI',b);i=12
    for offset in range(count):
        kind=b[i];i+=1;n,i=varint(b,i);key=b[i:i+n];i+=n;value=None
        if kind==1:n,i=varint(b,i);value=b[i:i+n];i+=n
        else:assert kind==0
        yield sequence+offset,key,value
    assert i==len(b),'unparsed batch bytes'

class NBT:
    def __init__(self,b):self.b=b;self.i=0
    def take(self,n):v=self.b[self.i:self.i+n];assert len(v)==n;self.i+=n;return v
    def num(self,fmt):return struct.unpack('<'+fmt,self.take(struct.calcsize('<'+fmt)))[0]
    def string(self):return self.take(self.num('H')).decode('utf8')
    def payload(self,t):
        if t==1:return self.num('b')
        if t==2:return self.num('h')
        if t==3:return self.num('i')
        if t==4:return self.num('q')
        if t==5:return self.num('f')
        if t==6:return self.num('d')
        if t==7:return self.take(self.num('i')).hex()
        if t==8:return self.string()
        if t==9:
            subtype=self.num('B');n=self.num('i');assert 0<=n<=1000000
            return [self.payload(subtype) for _ in range(n)]
        if t==10:
            result={}
            while True:
                subtype=self.num('B')
                if not subtype:return result
                name=self.string();assert name not in result;result[name]=self.payload(subtype)
        if t in (11,12):return [self.num('i' if t==11 else 'q') for _ in range(self.num('i'))]
        raise ValueError(f'unknown NBT tag {t}')
    def root(self):
        t=self.num('B');name=self.string();value=self.payload(t);assert self.i==len(self.b)
        return name,value

latest={};physical_log_files=[]
for file in sorted((BACKUP/'db').glob('*.log')):
    physical_log_files.append(file.name)
    for record in records(file.read_bytes()):
        for seq,key,value in batches(record):
            if key==b'DynamicProperties':
                if key not in latest or seq>latest[key][0]:latest[key]=(seq,value)
assert latest, 'no DynamicProperties snapshot found in backup WAL'
sequence,value=latest[b'DynamicProperties'];name,tree=NBT(value).root()
props=tree.get('fd04cb50-dddc-4ebe-83fc-5b5375819bcb',tree)
if 'civ:kingdom' not in props:
    raise ValueError('dynamic property UUID nesting differs: '+repr(list(tree)))
kingdom=json.loads(props['civ:kingdom'])
master_meta=json.loads(props['civ:plan:meta'])
master_text=''.join(props[f"civ:plan:{master_meta['fam']}:{i}"] for i in range(master_meta['chunks']))
fnv=0x811c9dc5
units=master_text.encode('utf-16-le')
for i in range(0,len(units),2):fnv=((fnv^int.from_bytes(units[i:i+2],'little'))*0x01000193)&0xffffffff
assert f'{fnv:08x}'==master_meta['hash']
assert len(master_text.encode('utf8'))==master_meta['bytes']
assert file_hashes=={str(p.relative_to(BACKUP)):hashlib.sha256(p.read_bytes()).hexdigest().upper() for p in sorted(BACKUP.rglob('*')) if p.is_file()},'backup changed during read-only audit'
report={'scope':'Closed-backup CRC-verified WAL DynamicProperties snapshot only; no SST/chunk/entity census',
    'backup':str(BACKUP),'files':len(list(p for p in BACKUP.rglob('*') if p.is_file())),
    'levelDatSha256':EXPECTED,'walFiles':physical_log_files,'snapshotSequence':sequence,
    'fileHashes':file_hashes,'filesStableDuringAudit':True,
    'masterPayloadVerified':{'hash':master_meta['hash'],'bytes':master_meta['bytes'],'chunks':master_meta['chunks']},
    'savedIdentity':{'schemaVersion':kingdom.get('schemaVersion'),'name':kingdom.get('name'),'seed':kingdom.get('seed')},
    'districts':[{'id':d.get('id'),'name':d.get('name'),'civ':d.get('civ')} for d in kingdom['districts']],
    'farmJournals':{k:json.loads(v) for k,v in props.items() if k.startswith('civ:farm_lights:')},
    'masterKeys':{k:(json.loads(v) if isinstance(v,str) and v.startswith('{') else str(v)[:200]) for k,v in props.items() if k.startswith('civ:plan:meta')},
    'packBindings':{p.name:json.loads(p.read_text(encoding='utf-8-sig')) for p in [BACKUP/'world_behavior_packs.json',BACKUP/'world_resource_packs.json']}}
output=ROOT/'dist/closed-kitchen-fern-journal-audit.json';output.write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report,indent=2))
