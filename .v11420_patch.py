from pathlib import Path
p=Path('api/index.js')
s=p.read_text()

a=s.index('async function findExactCartCard(page,b){')
z=s.index('\nasync function snapshotCart(page){',a)
replacement=r'''async function findExactCartCard(page,b){
  const label=norm(expectedLabel(b)).toLowerCase();
  const homeKey=teamKey(b.home), awayKey=teamKey(b.away);
  const cards=await simpleCards(page); const n=await cards.count();
  for(let i=0;i<n;i++){
    const c=cards.nth(i), text=norm(await c.innerText().catch(()=>''));
    const low=text.toLowerCase();
    const eventRe=new RegExp(`(?:N[°ºo]?\\s*)?${String(b.eventNumber).replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}\\b`,'i');
    const textKey=teamKey(text);
    const eventMatch=eventRe.test(text);
    const teamsMatch=!!homeKey&&!!awayKey&&textKey.includes(homeKey)&&textKey.includes(awayKey);
    if(!eventMatch && !teamsMatch) continue;
    if(label==='n'){
      const cleaned=text.replace(new RegExp('1\\s*/\\s*N\\s*/\\s*2','ig'),' ');
      if(new RegExp('(?:^|\\s)N(?:\\s|$)','i').test(cleaned)) return c;
    }else if(low.includes(label)) return c;
  }
  return null;
}
'''
s=s[:a]+replacement+s[z:]

a=s.index('async function stakeInputForBet(page,b){')
z=s.index('\nasync function waitCartAtLeast(page,minCount,timeoutMs){',a)
replacement=r'''async function stakeInputForBet(page,b,index=null){
  const card=await findExactCartCard(page,b);
  if(card){
    const input=card.locator('input').first();
    if(await input.count()) return input;
  }
  const idx=Number.isInteger(index)?index:(Number.isInteger(b?._cartIndex)?b._cartIndex:null);
  if(idx!==null){
    const input=page.locator('.cart-item.simple').nth(idx).locator('input').first();
    if(await input.count()) return input;
  }
  if(b?._stakeInputId){
    const id=String(b._stakeInputId).replace(/"/g,'\\"');
    const loc=page.locator(`input[id="${id}"]`).first();
    if(await loc.count()) return loc;
  }
  return null;
}
'''
s=s[:a]+replacement+s[z:]

a=s.index('async function setStake(page,b){')
z=s.index('\nasync function validateAndQr(page,bets){',a)
replacement=r'''async function setStake(page,b,index){
  const input=await stakeInputForBet(page,b,index);
  if(!input) throw new Error(`Mise N°${b.eventNumber} ${b.outcome} introuvable (index=${index}, inputId=${b._stakeInputId||'aucun'}).`);
  const val=String(Number(b.stake));
  await input.fill(val);
  await page.waitForTimeout(70);
  const check=await stakeInputForBet(page,b,index);
  if(!check) throw new Error(`Mise N°${b.eventNumber} ${b.outcome} disparue après saisie (index=${index}).`);
  const got=Number(await check.inputValue());
  if(Math.abs(got-Number(b.stake))>0.001) throw new Error(`Mise N°${b.eventNumber} ${b.outcome} non appliquée (${got} au lieu de ${b.stake}).`);
}
'''
s=s[:a]+replacement+s[z:]

old="""  for(const b of bets){ const input=await stakeInputForBet(page,b); if(!input) throw new Error(`Contrôle final impossible pour N°${b.eventNumber} ${b.outcome} (inputId=${b._stakeInputId||'aucun'}).`); const v=Number(await input.inputValue()); if(Math.abs(v-Number(b.stake))>.001) throw new Error(`Contrôle de mise incorrect pour N°${b.eventNumber} ${b.outcome}.`); total+=v; }
"""
new="""  for(let i=0;i<bets.length;i++){ const b=bets[i]; const input=await stakeInputForBet(page,b,i); if(!input) throw new Error(`Contrôle final impossible pour N°${b.eventNumber} ${b.outcome} (index=${i}, inputId=${b._stakeInputId||'aucun'}).`); const v=Number(await input.inputValue()); if(Math.abs(v-Number(b.stake))>.001) throw new Error(`Contrôle de mise incorrect pour N°${b.eventNumber} ${b.outcome}.`); total+=v; }
"""
if old not in s: raise SystemExit('validate stake loop not found')
s=s.replace(old,new,1)

old="""    const stakeIds=await cartStakeInputIds(page);
    if(stakeIds.length===bets.length){
      for(let i=0;i<bets.length;i++) if(!bets[i]._stakeInputId) bets[i]._stakeInputId=stakeIds[i];
    }

    stage='contrôle final des sélections';
"""
new="""    await page.waitForTimeout(250);
    const stakeIds=await cartStakeInputIds(page);
    if(stakeIds.length!==bets.length) throw new Error(`Binding des mises : ${stakeIds.length} champ(s) pour ${bets.length} pari(s).`);
    for(let i=0;i<bets.length;i++){
      bets[i]._cartIndex=i;
      bets[i]._stakeInputId=stakeIds[i];
    }

    stage='contrôle final des sélections';
"""
if old not in s: raise SystemExit('final binding block not found')
s=s.replace(old,new,1)

old="""    stage='application des mises';
    for(const b of bets) await setStake(page,b);
"""
new="""    stage='application des mises';
    for(let i=0;i<bets.length;i++) await setStake(page,bets[i],i);
"""
if old not in s: raise SystemExit('setStake loop not found')
s=s.replace(old,new,1)

s=s.replace('11.4.19','11.4.20')
p.write_text(s)
p=Path('index.html'); p.write_text(p.read_text().replace('V11.4.19','V11.4.20'))
p=Path('package.json'); p.write_text(p.read_text().replace('"version":"11.4.19"','"version":"11.4.20"'))
