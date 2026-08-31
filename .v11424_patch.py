from pathlib import Path

p=Path('api/index.js')
s=p.read_text()

a=s.index("  const qrReady = await page.waitForFunction(() => {")
z=s.index("  // V11.4.23: le QR officiel",a)
replacement=r'''  // V11.4.24 : après VALIDER, le site affiche une action "QR CODE" dans
  // le panier. Cliquer directement sur l'onglet "Mes QR codes" ne crée pas
  // l'e-bulletin : il faut d'abord déclencher cette action.
  const qrActionState = await page.waitForFunction(() => {
    const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
    const visible=el=>{const r=el.getBoundingClientRect();const cs=getComputedStyle(el);return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden';};
    const candidates=[...document.querySelectorAll('button,a,[role="button"]')]
      .filter(el=>el.id!=='qr-code-tab-button' && el.getAttribute('data')!=='app-cart|qrCodes' && !el.disabled && visible(el))
      .map(el=>{
        const text=norm(el.innerText||el.textContent||'');
        const aria=norm(el.getAttribute('aria-label')||'');
        const title=norm(el.getAttribute('title')||'');
        let score=-1;
        if(/^QR\s*CODE$/i.test(text)) score=100;
        else if(/^QR\s*CODE$/i.test(aria)||/^QR\s*CODE$/i.test(title)) score=95;
        else if(/\bQR\s*CODE\b/i.test(text) && !/Mes\s+QR/i.test(text)) score=60-Math.min(30,text.length/10);
        return {el,score,text,aria,title};
      }).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score);
    const best=candidates[0];
    if(!best) return null;
    best.el.setAttribute('data-l1maggle-qr-action','1');
    return {text:best.text,aria:best.aria,title:best.title,tag:best.el.tagName,id:best.el.id||null,score:best.score};
  }, {timeout:5000}).then(h=>h.jsonValue()).catch(()=>null);

  if(!qrActionState){
    const buttons=await page.evaluate(()=>{
      const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
      return [...document.querySelectorAll('button,a,[role="button"]')]
        .filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;})
        .map(el=>({id:el.id||null,text:norm(el.innerText||el.textContent||''),aria:el.getAttribute('aria-label'),disabled:!!el.disabled}))
        .filter(x=>/QR|VALIDER|OPTION/i.test((x.text||'')+' '+(x.aria||''))).slice(0,30);
    }).catch(()=>[]);
    throw new Error('Action QR CODE introuvable après VALIDER. boutons='+JSON.stringify(buttons));
  }

  const qrActionClicked=await page.evaluate(()=>{
    const el=document.querySelector('[data-l1maggle-qr-action="1"]');
    if(!el || el.disabled) return false;
    el.scrollIntoView({block:'center'});
    el.click();
    return true;
  }).catch(()=>false);
  if(!qrActionClicked) throw new Error('Action QR CODE détectée mais clic impossible. action='+JSON.stringify(qrActionState));

  await page.waitForTimeout(650);

  // Une fois l'e-bulletin créé, ouvrir "Mes QR codes" si nécessaire.
  const qrTabReady = await page.waitForFunction(() => {
    const btn=document.querySelector('#qr-code-tab-button, button[data="app-cart|qrCodes"]');
    return !!btn && !btn.disabled;
  }, {timeout:5000}).then(()=>true).catch(()=>false);
  if (!qrTabReady) throw new Error('Onglet Mes QR codes introuvable après génération de l’e-bulletin. action='+JSON.stringify(qrActionState));

  const qrTabState = await page.evaluate(() => {
    const btn=document.querySelector('#qr-code-tab-button, button[data="app-cart|qrCodes"]');
    if(!btn || btn.disabled) return {ok:false};
    const cls=String(btn.className||'');
    const already=/selected|active/i.test(cls)||btn.getAttribute('aria-selected')==='true';
    if(!already) btn.click();
    return {ok:true,already,cls,text:String(btn.innerText||btn.textContent||'').trim()};
  }).catch(()=>({ok:false}));
  if(!qrTabState.ok) throw new Error('Onglet Mes QR codes détecté mais ouverture impossible.');
  await page.waitForTimeout(500);

'''
s=s[:a]+replacement+s[z:]

s=s.replace('11.4.23','11.4.24')
p.write_text(s)

p=Path('index.html')
p.write_text(p.read_text().replace('V11.4.23','V11.4.24'))

p=Path('package.json')
p.write_text(p.read_text().replace('"version":"11.4.23"','"version":"11.4.24"'))
