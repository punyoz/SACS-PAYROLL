# Builds public/ph-barangays/<region>.json from the PSA PSGC lists (alpha test B, 2026-11-09).
# Inputs (download first, into the working folder): https://psgc.gitlab.io/api/{provinces,cities-municipalities,barangays}/
# saved as provinces.json, cities-municipalities.json, barangays.json, plus ours.json = the app lists
# (PH_REGIONS / PH_PROVINCES / PH_CITIES / PH_BARANGAYS from src/lib/portal/ph-locations.js).
# Usage: python -I build-ph-barangays.py <repo>/public/ph-barangays
import json, unicodedata, re, os, sys
out_dir=sys.argv[1]
o=json.load(open('ours.json',encoding='utf-8'))
prov=json.load(open('provinces.json',encoding='utf-8')); cities=json.load(open('cities-municipalities.json',encoding='utf-8'))
brgy=json.load(open('barangays.json',encoding='utf-8'))
def norm(s):
    s=unicodedata.normalize('NFKD',s).encode('ascii','ignore').decode().lower()
    s=s.replace('sto.','santo').replace('sta.','santa')
    s=re.sub(r'\bcity of\b|\bcity\b','',s); return re.sub(r'[^a-z0-9]','',s)
pn={norm(p['name']):p['code'] for p in prov}
byprov={}
for c in cities: byprov.setdefault(c['provinceCode'],[]).append(c)
code_of={c['code']:c for c in cities}
def find_in(pool,name):
    m=[x for x in pool if norm(x['name'])==norm(name)]; return m[0]['code'] if len(m)==1 else None
ALIAS={('Pangasinan','Pozzorubio'):'Pozorrubio',('Camarines Sur','Sagnas'):'Sagñay',('Negros Occidental','Don Salvador Benedicto'):'Salvador Benedicto',('Sultan Kudarat','Senator Ninoy Aquino'):'Sen. Ninoy Aquino'}
CODE={('Nueva Ecija','Munoz City'):'034917000',('Palawan','Turtle Islands'):'157008000',('Antique','San Jose de Buenavista'):'060613000',('Zamboanga del Norte','Leon B. Postigo'):'097226000',('Basilan','Isabela City'):'099701000',('Lanao del Sur','Bumbaran'):'153637000',('Sulu','Banguingui'):'156615000',('Cavite','General Mariano Alvarez'):'042123000',('Zamboanga del Norte','President Manuel A. Roxas'):'097211000',('Davao del Norte','Samal City'):'112317000',('Davao Oriental','Gov. Generoso'):'112506000',('Maguindanao del Sur','Datu Montawal'):'153822000',('Maguindanao del Sur','General Salipada K. Pendatun'):'153819000'}
REGION_WIDE={('Zamboanga del Norte','San Miguel'),('Zamboanga del Norte','San Pablo'),('Davao del Sur','Jose Abad Santos'),('Sulu','Languyan')}
mapping={}; unmatched=[]
for r in o['R']:
  for p in o['P'][r]:
    if p=='Metro Manila': pool=[x for x in cities if x['regionCode']=='130000000']
    elif p.startswith('Maguindanao'): pool=byprov.get('153800000',[])
    else: pool=byprov.get(pn.get(norm(p)),[])
    for c in o['C'].get(p,[]):
      key=(p,c); code=CODE.get(key) or find_in(pool, ALIAS.get(key,c))
      if not code and key in REGION_WIDE:
        rc=code_of[pool[0]['code']]['regionCode']; code=find_in([x for x in cities if x['regionCode']==rc], c)
      if code: mapping[key]=(r,code)
      else: unmatched.append(f'{r} / {p} / {c}')
children={}
for x in brgy:
    parent=x['cityCode'] or x['municipalityCode']
    children.setdefault(parent,[]).append(x['name'])
os.makedirs(out_dir,exist_ok=True)
files={}; total=0
for (p,c),(r,code) in mapping.items():
    names=sorted(set(children.get(code,[])), key=lambda s: unicodedata.normalize('NFKD',s).lower())
    if not names: unmatched.append(f'{r} / {p} / {c} (no barangays in PSGC)'); continue
    files.setdefault(r,{})[f'{p}|{c}']=names; total+=len(names)
def slug(r): return re.sub(r'[^a-z0-9]+','-',r.lower()).strip('-')
for r,data in files.items():
    json.dump(data, open(os.path.join(out_dir, slug(r)+'.json'),'w',encoding='utf-8'), ensure_ascii=False, separators=(',',':'), sort_keys=True)
json.dump({'regions':{r:slug(r) for r in files},'unmatched':unmatched,'cities':len(mapping),'barangays':total}, open('summary.json','w',encoding='utf-8'), ensure_ascii=False, indent=1)
print('cities mapped',len(mapping),'barangays',total,'unmatched',len(unmatched))
print('\n'.join(unmatched))
