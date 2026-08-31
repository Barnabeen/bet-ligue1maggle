from pathlib import Path
p=Path('api/index.js')
s=p.read_text()
anchor="  if (!qrClicked) throw new Error('Bouton QR CODE détecté mais clic DOM impossible.');"
a=s.index(anchor)
start=s.index('\n  const end=Date.now()+8000;',a)
throw_line="\n  throw new Error('QR Code officiel introuvable après validation.');"
z=s.index(throw_line,start)+len(throw_line)
replacement=r'''
  // V11.4.23: le QR officiel n'est plus supposé être uniquement un <img>
  // PNG base64 de 100–190 px. Parions Sport peut le rendre en canvas, SVG,
  // blob/http ou dans un composant dont il faut capturer visuellement le carré.
  await page.waitForTimeout(450);
  const qrEnd=Date.now()+8500;
  while(Date.now()<qrEnd){
    const direct=await page.evaluate(()=>{
      const visible=el=>{const r=el.getBoundingClientRect();const cs=getComputedStyle(el);return r.width>=80&&r.height>=80&&cs.display!=='none'&&cs.visibility!=='hidden';};
      const square=el=>{const r=el.getBoundingClientRect();if(!visible(el))return false;const ratio=Math.max(r.width,r.height)/Math.max(1,Math.min(r.width,r.height));return ratio<=1.16&&r.width<=420&&r.height<=420;};
      const imgs=[...document.querySelectorAll('img')].filter(square);
      for(const img of imgs){
        const src=img.currentSrc||img.src||'';
        if(/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(src)) return {kind:'img-data',dataUrl:src};
      }
      const canvases=[...document.querySelectorAll('canvas')].filter(square);
      for(const c of canvases){ try{ const u=c.toDataURL('image/png'); if(u&&u.length>200) return {kind:'canvas',dataUrl:u}; }catch{} }
      const svgs=[...document.querySelectorAll('svg')].filter(square);
      for(const svg of svgs){
        const key=((svg.id||'')+' '+String(svg.className?.baseVal||svg.className||'')+' '+String(svg.parentElement?.className||'')).toLowerCase();
        if(!/qr|code/.test(key) && svg.querySelectorAll('rect,path').length<20) continue;
        try{
          const xml=new XMLSerializer().serializeToString(svg);
          const dataUrl='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(xml)));
          if(dataUrl.length>300) return {kind:'svg',dataUrl};
        }catch{}
      }
      return null;
    }).catch(()=>null);
    if(direct?.dataUrl) return {count:bets.length,total,qrDataUrl:direct.dataUrl,qrKind:direct.kind};

    const marked=await page.evaluate(()=>{
      document.querySelectorAll('[data-l1maggle-qr-candidate="1"]').forEach(el=>el.removeAttribute('data-l1maggle-qr-candidate'));
      const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
      const visible=el=>{const r=el.getBoundingClientRect();const cs=getComputedStyle(el);return r.width>=80&&r.height>=80&&cs.display!=='none'&&cs.visibility!=='hidden';};
      const candidates=[...document.querySelectorAll('img,canvas,svg,[class*="qr" i],[id*="qr" i]')].filter(el=>{
        if(!visible(el)) return false;
        const r=el.getBoundingClientRect();
        const ratio=Math.max(r.width,r.height)/Math.max(1,Math.min(r.width,r.height));
        return ratio<=1.18&&r.width<=420&&r.height<=420;
      });
      const scored=candidates.map(el=>{
        const r=el.getBoundingClientRect();
        let score=0;
        const key=((el.id||'')+' '+String(el.className?.baseVal||el.className||'')).toLowerCase();
        if(/qr|qrcode|qr-code/.test(key)) score+=80;
        if(el.tagName==='CANVAS') score+=35;
        if(el.tagName==='IMG') score+=30;
        if(el.tagName==='SVG') score+=25;
        if(r.width>=110&&r.width<=260&&r.height>=110&&r.height<=260) score+=25;
        let cur=el;
        for(let d=0;cur&&d<6;d++,cur=cur.parentElement){
          const t=norm(cur.innerText||cur.textContent||'');
          if(/Mes QR|QR\s*Code|Paris simples|Mise totale|Gains potentiels/i.test(t)){score+=45;break;}
        }
        return {el,score,w:Math.round(r.width),h:Math.round(r.height),tag:el.tagName,key:key.slice(0,180)};
      }).sort((a,b)=>b.score-a.score);
      const best=scored[0];
      if(!best) return null;
      best.el.setAttribute('data-l1maggle-qr-candidate','1');
      return {score:best.score,w:best.w,h:best.h,tag:best.tag,key:best.key};
    }).catch(()=>null);

    if(marked){
      const loc=page.locator('[data-l1maggle-qr-candidate="1"]').first();
      const png=await loc.screenshot({type:'png',timeout:2500}).catch(()=>null);
      if(png?.length>200) return {count:bets.length,total,qrDataUrl:'data:image/png;base64,'+png.toString('base64'),qrKind:'element-screenshot',qrCandidate:marked};
    }
    await page.waitForTimeout(180);
  }

  const qrDebug=await page.evaluate(()=>{
    const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
    const desc=el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,id:el.id||null,cls:String(el.className?.baseVal||el.className||'').slice(0,160),w:Math.round(r.width),h:Math.round(r.height),text:norm(el.innerText||el.textContent||'').slice(0,240),src:String(el.currentSrc||el.src||'').slice(0,180)};};
    return {
      url:location.href,
      qrTab:desc(document.querySelector('#qr-code-tab-button,button[data="app-cart|qrCodes"]')),
      qrish:[...document.querySelectorAll('[class*="qr" i],[id*="qr" i],canvas,svg,img')].filter(el=>{const r=el.getBoundingClientRect();return r.width>=50&&r.height>=50;}).slice(0,30).map(desc),
      body:norm(document.body.innerText||'').slice(-1800)
    };
  }).catch(()=>null);
  throw new Error(`QR Code officiel introuvable après validation. debug=${JSON.stringify(qrDebug)}`);'''
s=s[:start]+replacement+s[z:]
s=s.replace('11.4.22','11.4.23')
p.write_text(s)
p=Path('index.html'); p.write_text(p.read_text().replace('V11.4.22','V11.4.23'))
p=Path('package.json'); p.write_text(p.read_text().replace('"version":"11.4.22"','"version":"11.4.23"'))
