from pathlib import Path

p=Path('api-index.js')
s=p.read_text()
s=s.replace("version:'11.4.12'","version:'11.4.13'").replace("version:'11.4.11'","version:'11.4.13'")
old_sync="if(action==='sync'){ const data=await scrapeLigue1Maggle(page); const events=await scrapeParionsL1Events(page); return res.status(200).json({ok:true,data:attachParionsNumbers(data,events)}); }"
new_sync="if(action==='sync'){ const data=await scrapeLigue1Maggle(page); return res.status(200).json({ok:true,data}); }"
if old_sync in s:
    s=s.replace(old_sync,new_sync)
old_create="""async function createBulletin(page,inputBets){
  const bets=aggregateBets(inputBets);
  await page.goto(PS_URL,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1200);
  await dismissPrivacyOverlay(page);
"""
new_create="""async function createBulletin(page,inputBets){
  const events=await scrapeParionsL1Events(page);
  const resolved=(inputBets||[]).map(b=>{
    let e=(events||[]).find(x=>sameTeam(b.home,x.home)&&sameTeam(b.away,x.away));
    if(!e) e=(events||[]).find(x=>sameTeam(b.home,x.away)&&sameTeam(b.away,x.home));
    if(!e) throw new Error(`Correspondance Parions Sport introuvable pour ${b.home} – ${b.away}. Événements détectés: ${(events||[]).length}.`);
    return {...b,eventNumber:e.eventNumber};
  });
  const bets=aggregateBets(resolved);
  await page.waitForTimeout(300);
  await dismissPrivacyOverlay(page);
"""
if old_create not in s:
    raise SystemExit('createBulletin marker missing')
s=s.replace(old_create,new_create)
p.write_text(s)

p=Path('index.html')
h=p.read_text().replace('V11.4.12','V11.4.13').replace('V11.4.11','V11.4.13')
old_bets="function bets(){const a=[];(D.matchs||[]).forEach((m,i)=>sel.forEach(n=>{const o=m.pronostics?.[n],num=m.eventNumber;if(['1','N','2'].includes(o)&&num)a.push({i,n,o,m,num,stake:stakes[k(i,n)]??1})}));return a}"
new_bets="function bets(){const a=[];(D.matchs||[]).forEach((m,i)=>sel.forEach(n=>{const o=m.pronostics?.[n],num=m.eventNumber||null;if(['1','N','2'].includes(o))a.push({i,n,o,m,num,stake:stakes[k(i,n)]??1})}));return a}"
if old_bets not in h:
    raise SystemExit('frontend bets marker missing')
h=h.replace(old_bets,new_bets)
start=h.find("const bs=bets();rows.innerHTML=")
end=h.find(";document.querySelectorAll('[data-d]')",start)
if start<0 or end<0:
    raise SystemExit('frontend rows marker missing')
replacement="""const bs=bets();const validSelected=(D.matchs||[]).reduce((c,m)=>c+[...sel].filter(n=>['1','N','2'].includes(m.pronostics?.[n])).length,0);rows.innerHTML=bs.map(b=>`<div class=row><span>${E(b.m.domicile)} – ${E(b.m.exterieur)} · <b>${b.o}</b> · ${E(b.n)} · ${b.num?'N°'+b.num:'N° auto'}</span><div class=stake><button class=alt data-d=-1 data-i=${b.i} data-n="${E(b.n)}">−</button><input class=st type=number min=1 data-i=${b.i} data-n="${E(b.n)}" value=${b.stake}><button class=alt data-d=1 data-i=${b.i} data-n="${E(b.n)}">+</button></div></div>`).join('')||`<div class=status>Aucun pari exploitable. Diagnostic : ${sel.size} joueur(s) sélectionné(s), ${validSelected} pronostic(s) 1/N/2 détecté(s).</div>`"""
h=h[:start]+replacement+h[end:]
p.write_text(h)

p=Path('package.json')
q=p.read_text().replace('"version":"11.4.12"','"version":"11.4.13"').replace('"version":"11.4.11"','"version":"11.4.13"')
p.write_text(q)
