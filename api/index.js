import { chromium } from 'playwright-core';

const L1_URL = 'https://ligue1maggle.netlify.app/';

function browserlessConfigured(){ return !!(process.env.BROWSERLESS_TOKEN || process.env.BROWSERLESS_WS); }
async function openRemoteBrowser(){
  const direct = process.env.BROWSERLESS_WS;
  const token = process.env.BROWSERLESS_TOKEN;
  if (!direct && !token) throw new Error('BROWSERLESS_NOT_CONFIGURED');
  const base = direct || `wss://production-sfo.browserless.io?token=${encodeURIComponent(token)}&blockAds=true`;
  const sessionTimeout=Math.max(60000,Number(process.env.BROWSERLESS_SESSION_TIMEOUT_MS)||120000);
  const ws = /[?&]timeout=\d+/i.test(base) ? base : `${base}${base.includes('?')?'&':'?'}timeout=${sessionTimeout}`;
  return chromium.connectOverCDP(ws,{timeout:20000});
}
async function getPage(browser){
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(20000);
  return page;
}

async function scrapeLigue1Maggle(page,targetEvents=[]){
  await page.goto(L1_URL,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1200);
  return await page.evaluate(async(targetEvents)=>{
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const txt = el => norm(el?.innerText || el?.textContent || '');
    const visible = el => {
      if(!el) return false;
      const r=el.getBoundingClientRect();
      const cs=getComputedStyle(el);
      return r.width>0 && r.height>0 && cs.display!=='none' && cs.visibility!=='hidden';
    };
    const teamKey=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
      .replace(/\b(fc|ac|as|stade|olympique|club)\b/g,' ')
      .replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
    const sameTeam=(a,b)=>{const x=teamKey(a),y=teamKey(b);return !!x&&!!y&&(x===y||x.includes(y)||y.includes(x));};

    function clickText(re) {
      const els = [...document.querySelectorAll('button,a,[role="button"],nav *')].filter(visible);
      const el = els.find(e => re.test(txt(e)));
      if (el) { el.click(); return true; }
      return false;
    }
    async function go(re) { clickText(re); await sleep(700); }

    clickText(/Ouais ouais|j.?assume/i);
    await sleep(400);
    await go(/pronostics?|grille/i);

    function journeeForTable(table){
      let cur=table;
      for(let depth=0;cur&&depth<6;depth++,cur=cur.parentElement){
        const local=[...cur.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="jour" i],button,span,div')]
          .map(el=>txt(el)).filter(t=>/^JOURN[ÉE]E?\s*\d+$/i.test(t));
        const unique=[...new Set(local.map(t=>+(t.match(/(\d+)/)||[])[1]).filter(Number.isFinite))];
        if(unique.length===1) return unique[0];
        let sib=cur.previousElementSibling;
        for(let i=0;sib&&i<4;i++,sib=sib.previousElementSibling){
          const m=txt(sib).match(/JOURN[ÉE]E?\s*(\d+)/i);
          if(m && txt(sib).length<120) return +m[1];
        }
      }
      const labels=[...document.querySelectorAll('*')].filter(el=>visible(el)&&/^JOURN[ÉE]E?\s*\d+$/i.test(txt(el)));
      const nums=[...new Set(labels.map(el=>+(txt(el).match(/(\d+)/)||[])[1]).filter(Number.isFinite))];
      if(nums.length===1) return nums[0];
      return null;
    }

    function parseTable(table){
      const rows=[...table.querySelectorAll('tr')];
      if(rows.length<3 || !rows.some(r=>/\bvs\b/i.test(txt(r)))) return null;
      const headerCells=[...rows[0].querySelectorAll('th,td')].map(txt);
      const playerNames=headerCells.slice(1).filter(Boolean);
      const matchs=[];
      for(const row of rows.slice(1)){
        const cells=[...row.querySelectorAll('th,td')];
        if(!cells.length) continue;
        const first=txt(cells[0]);
        const mm=first.match(/(.+?)\s+vs\s+(.+?)(?:\s+(?:ven|sam|dim|lun|mar|mer|jeu)\.?|\s+\d{1,2}:\d{2}|$)/i);
        if(!mm) continue;
        const pronostics={};
        cells.slice(1).forEach((c,i)=>{
          const raw=txt(c).trim();
          const v=raw.match(/^(1|N|2|X|✗)$/i)?.[1]?.toUpperCase();
          if(playerNames[i]&&v) pronostics[playerNames[i]]=v;
        });
        matchs.push({domicile:norm(mm[1]),exterieur:norm(mm[2]),pronostics});
      }
      if(matchs.length<5) return null;
      return {journee:journeeForTable(table),matchs,joueurs:playerNames,visible:visible(table)};
    }

    function overlapWithParions(matchs){
      if(!Array.isArray(targetEvents)||!targetEvents.length) return 0;
      return matchs.filter(m=>targetEvents.some(e=>
        (sameTeam(m.domicile,e.home)&&sameTeam(m.exterieur,e.away)) ||
        (sameTeam(m.domicile,e.away)&&sameTeam(m.exterieur,e.home))
      )).length;
    }

    function extractPronostics(){
      const candidates=[...document.querySelectorAll('table')].map(parseTable).filter(Boolean)
        .map((c,i)=>({...c,index:i,overlap:overlapWithParions(c.matchs)}));
      if(!candidates.length) return {journee:null,matchs:[],joueurs:[],warning:'Table de pronostics non reconnue.',overlap:0,diagnostics:{candidates:[]}};
      candidates.sort((a,b)=>b.overlap-a.overlap || Number(b.visible)-Number(a.visible) || b.matchs.length-a.matchs.length);
      const best=candidates[0];
      return {...best,diagnostics:{candidates:candidates.map(c=>({index:c.index,journee:c.journee,visible:c.visible,overlap:c.overlap,matchs:c.matchs.map(m=>`${m.domicile}-${m.exterieur}`)})),selected:{index:best.index,journee:best.journee,visible:best.visible,overlap:best.overlap}}};
    }

    async function tryAdvanceJournee(currentJournee){
      const selects=[...document.querySelectorAll('select')].filter(visible);
      for(const sel of selects){
        const opts=[...sel.options];
        const idx=sel.selectedIndex;
        const next=opts.find((o,i)=>i>idx && /JOURN[ÉE]E?|J\s*\d+/i.test(txt(o))) || opts[idx+1];
        if(next){
          sel.value=next.value;
          sel.dispatchEvent(new Event('input',{bubbles:true}));
          sel.dispatchEvent(new Event('change',{bubbles:true}));
          await sleep(500);
          return true;
        }
      }
      const controls=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
      const wanted=controls.find(el=>{
        const t=norm([txt(el),el.getAttribute('aria-label'),el.getAttribute('title')].filter(Boolean).join(' '));
        return /(?:journ[ée]e?.*)?(suiv|next|prochain)|^(?:>|›|»|→)$/i.test(t);
      });
      if(wanted){ wanted.click(); await sleep(500); return true; }
      if(Number.isFinite(currentJournee)){
        const byNumber=controls.find(el=>{
          const t=txt(el);
          return new RegExp(`^(?:J(?:OURN[ÉE]E?)?\\s*)?${currentJournee+1}$`,'i').test(t);
        });
        if(byNumber){ byNumber.click(); await sleep(500); return true; }
      }
      return false;
    }

    let p=extractPronostics();
    if(Array.isArray(targetEvents)&&targetEvents.length && p.overlap===0){
      for(let step=0;step<4;step++){
        const moved=await tryAdvanceJournee(p.journee);
        if(!moved) break;
        const next=extractPronostics();
        if(next.overlap>=p.overlap) p=next;
        if(p.overlap>0) break;
      }
    }

    const knownPlayers=p.joueurs;
    await go(/classement/i);

    function pointsNearPlayer(player) {
      const candidates = [...document.querySelectorAll('div,li,tr,article,section')];
      const hits = candidates.filter(el => {
        const t = txt(el);
        if (!t.toUpperCase().includes(player.toUpperCase())) return false;
        if (!/\d+(?:[.,]\d+)?\s*pts?\b/i.test(t)) return false;
        return ![...el.children].some(c => {
          const ct = txt(c);
          return ct.toUpperCase().includes(player.toUpperCase()) && /\d+(?:[.,]\d+)?\s*pts?\b/i.test(ct);
        });
      });
      for (const el of hits) {
        const m = txt(el).match(/(\d+(?:[.,]\d+)?)\s*pts?\b/i);
        if (m) return parseFloat(m[1].replace(',', '.'));
      }
      const nameEls = [...document.querySelectorAll('*')].filter(el => {
        const t = txt(el);
        return t && t.toUpperCase() === player.toUpperCase();
      });
      for (const nameEl of nameEls) {
        let cur = nameEl;
        for (let i=0; i<5 && cur; i++, cur=cur.parentElement) {
          const m = txt(cur).match(/(\d+(?:[.,]\d+)?)\s*pts?\b/i);
          if (m) return parseFloat(m[1].replace(',', '.'));
        }
      }
      return null;
    }

    const classement = knownPlayers
      .map(joueur => ({ joueur, points: pointsNearPlayer(joueur) }))
      .filter(x => Number.isFinite(x.points))
      .sort((a,b) => b.points - a.points)
      .map((x,i) => ({ rang:i+1, ...x }));

    return {journee:p.journee,classement,matchs:p.matchs,sourceDiagnostics:p.diagnostics};
  },targetEvents);
}

const PS_L1_URL = 'https://www.pointdevente.parionssport.fdj.fr/paris-ouverts/football/l1-mcdonald-s/45452';
function decodeHtmlText(html){
  return String(html||'')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;|&#160;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&apos;|&#39;|&rsquo;/gi,"'")
    .replace(/&quot;|&#34;/gi,'"')
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;/gi,'-')
    .replace(/\s+/g,' ')
    .trim();
}
function parseParionsL1EventsText(text){
  const out=[], seen=new Set();
  const re=/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .'-]{1,38})\s*-\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .'-]{1,38})\s+L1\s+McDonald'?s\s+N[°ºo]?\s*(\d+)\s+1\s*\/\s*N\s*\/\s*2/gi;
  let m;
  while((m=re.exec(String(text||'')))){
    const home=m[1].trim(), away=m[2].trim(), eventNumber=Number(m[3]);
    if(!home||!away||!Number.isFinite(eventNumber)||seen.has(eventNumber)) continue;
    seen.add(eventNumber);
    out.push({home,away,eventNumber,raw:m[0]});
  }
  return out;
}
async function fetchParionsL1EventsHttp(){
  const r=await fetch(PS_L1_URL,{
    headers:{
      'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      'accept':'text/html,application/xhtml+xml'
    },
    redirect:'follow'
  });
  if(!r.ok) throw new Error(`PARIONS_HTTP_${r.status}`);
  const html=await r.text();
  const events=parseParionsL1EventsText(decodeHtmlText(html));
  if(!events.length) throw new Error('PARIONS_HTTP_NO_L1_EVENTS');
  return events;
}

async function scrapeParionsL1Events(page){
  await page.goto(PS_L1_URL,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1200);
  await dismissPrivacyOverlay(page).catch(()=>{});
  return page.evaluate(()=>{
    const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
    const out=[], seen=new Set();

    const anchors=[...document.querySelectorAll('a')];
    for(const a of anchors){
      const t=norm(a.innerText||a.textContent||'');
      const n=t.match(/N[°ºo]?\s*(\d+)/i);
      if(!n || !/1\s*\/\s*N\s*\/\s*2/i.test(t)) continue;

      const prefix=t.slice(0,n.index).replace(/\s+L1\s+McDonald'?s.*$/i,'').trim();
      const sep=prefix.indexOf('-');
      if(sep<=0 || sep>=prefix.length-1) continue;

      const home=norm(prefix.slice(0,sep));
      const away=norm(prefix.slice(sep+1));
      const eventNumber=Number(n[1]);
      if(!home || !away || !Number.isFinite(eventNumber) || seen.has(eventNumber)) continue;

      seen.add(eventNumber);
      out.push({home,away,eventNumber,raw:t});
    }

    if(!out.length){
      for(const el of document.querySelectorAll('body *')){
        const t=norm(el.innerText||el.textContent||'');
        const n=t.match(/N[°ºo]?\s*(\d+)/i);
        if(!n || !/1\s*\/\s*N\s*\/\s*2/i.test(t)) continue;
        if([...el.children].some(c=>{
          const x=norm(c.innerText||c.textContent||'');
          return /N[°ºo]?\s*\d+/i.test(x)&&/1\s*\/\s*N\s*\/\s*2/i.test(x);
        })) continue;
        const prefix=t.slice(0,n.index).replace(/\s+L1\s+McDonald'?s.*$/i,'').trim();
        const sep=prefix.indexOf('-');
        if(sep<=0 || sep>=prefix.length-1) continue;
        const home=norm(prefix.slice(0,sep)), away=norm(prefix.slice(sep+1));
        const eventNumber=Number(n[1]);
        if(!home||!away||!Number.isFinite(eventNumber)||seen.has(eventNumber)) continue;
        seen.add(eventNumber);
        out.push({home,away,eventNumber,raw:t.slice(0,300)});
      }
    }
    return out;
  });
}
function teamKey(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(fc|ac|as|stade|olympique|club)\b/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function sameTeam(a,b){const x=teamKey(a),y=teamKey(b);return !!x&&!!y&&(x===y||x.includes(y)||y.includes(x));}
function attachParionsNumbers(data,events){
  const matchs=(data.matchs||[]).map(m=>{
    let e=(events||[]).find(x=>sameTeam(m.domicile,x.home)&&sameTeam(m.exterieur,x.away));
    let reversed=false;
    if(!e){
      e=(events||[]).find(x=>sameTeam(m.domicile,x.away)&&sameTeam(m.exterieur,x.home));
      reversed=!!e;
    }
    return {...m,eventNumber:e?.eventNumber||null,parionsMatch:e?{home:e.home,away:e.away,reversed}:null};
  });
  return {...data,matchs,parionsEvents:events||[],mappingDiagnostics:{
    ligue1Matches:matchs.length,
    parionsEvents:(events||[]).length,
    mapped:matchs.filter(m=>m.eventNumber).length,
    unmapped:matchs.filter(m=>!m.eventNumber).map(m=>({home:m.domicile,away:m.exterieur}))
  }};
}




function aggregateBets(bets){
  const m=new Map();
  for(const b of bets||[]){
    const key=`${b.eventNumber}|${b.outcome}`;
    if(!m.has(key)) m.set(key,{...b,stake:0});
    m.get(key).stake += Number(b.stake)||0;
  }
  return [...m.values()];
}
const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
function expectedLabel(b){ return b.outcome==='1'?b.home:b.outcome==='2'?b.away:'N'; }
async function simpleCards(page){ return page.locator('.cart-item.simple, app-bet-simple .cart-item, app-bet-simple'); }
async function uniqueSimpleCardCount(page){
  const ids=await cartStakeInputIds(page).catch(()=>[]);
  if(ids.length) return ids.length;
  return page.locator('.cart-item.simple, app-bet-simple').evaluateAll(cards => {
    const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
    const signatures=new Set();
    for(const card of cards){
      const input=card.querySelector('input');
      const id=input?.id || input?.getAttribute('name') || '';
      const text=norm(card.innerText || card.textContent || '');
      const value=input?.value || '';
      signatures.add(id ? `id:${id}` : `txt:${text}|stake:${value}`);
    }
    return signatures.size;
  });
}

async function cartCount(page){
  const n=await page.locator('[data="app-cart|nbreParisPanier"], .tabs-cart_number').first().textContent().catch(()=>null);
  const v=parseInt(String(n||'').replace(/\D/g,''),10); if(Number.isFinite(v)) return v;
  return await uniqueSimpleCardCount(page);
}

async function activeOutcomeCount(page){
  return page.evaluate(()=>{
    const visible=el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
    const truthy=v=>String(v||'').toLowerCase()==='true';
    const active=el=>{
      if(!el) return false;
      if(truthy(el.getAttribute('aria-pressed'))||truthy(el.getAttribute('aria-selected'))||truthy(el.getAttribute('aria-checked'))) return true;
      if(el.matches?.(':checked')) return true;
      if(el.querySelector?.('input:checked')) return true;
      for(const name of ['data-selected','data-active','data-checked','selected','active']) if(truthy(el.getAttribute?.(name))) return true;
      let cur=el;
      for(let i=0;cur&&i<3;i++,cur=cur.parentElement){
        const cls=String(cur.className||'');
        if(/(^|[\s_-])(selected|active|checked|chosen|is-selected|is-active)([\s_-]|$)/i.test(cls)) return true;
      }
      return false;
    };
    return [...document.querySelectorAll('button.outcomeButton,.outcomeButton')].filter(el=>visible(el)&&active(el)).length;
  });
}

async function dismissPrivacyOverlay(page){
  const overlay = page.locator('#privacy-overlay, .tc-privacy-overlay').first();
  if (!await overlay.count()) return;
  if (!await overlay.isVisible().catch(()=>false)) return;
  const preferred = [/continuer\s+sans\s+accepter/i,/tout\s+refuser/i,/^refuser$/i,/refuser\s+et\s+fermer/i,/enregistrer\s+(?:mes\s+)?choix/i,/confirmer\s+(?:mes\s+)?choix/i,/fermer/i,/tout\s+accepter/i,/^accepter$/i];
  for (const re of preferred) {
    const candidate = page.getByRole('button', { name: re }).first();
    if (await candidate.count() && await candidate.isVisible().catch(()=>false)) {
      await candidate.evaluate(el => el.click()).catch(()=>{}); await page.waitForTimeout(350);
      if (!await overlay.isVisible().catch(()=>false)) return;
    }
  }
  const clicked = await page.evaluate(() => {
    const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
    const patterns=[/continuer\s+sans\s+accepter/i,/tout\s+refuser/i,/^refuser$/i,/refuser\s+et\s+fermer/i,/enregistrer\s+(?:mes\s+)?choix/i,/confirmer\s+(?:mes\s+)?choix/i,/^fermer$/i,/tout\s+accepter/i,/^accepter$/i];
    const els=[...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')];
    for(const re of patterns){ const el=els.find(x=>re.test(norm(x.innerText||x.textContent||x.value)) && x.offsetParent!==null); if(el){el.click();return true;} }
    return false;
  }).catch(()=>false);
  if(clicked) await page.waitForTimeout(500);
  if(await overlay.isVisible().catch(()=>false)) throw new Error('Le bandeau de confidentialité Parions Sport est toujours ouvert et bloque les clics.');
}

async function ensureSimpleMode(page){
  const info=await page.evaluate(()=>{
    const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
    const visible=el=>{ if(!el) return false; const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden'; };
    const clicked=[];
    const cartTabs=[...document.querySelectorAll('button.tabs-cart_btn')].filter(visible);
    const cartTab=cartTabs.find(b=>b.id!=='qr-code-tab-button' && !/QR\s*CODE/i.test(norm(b.innerText||b.textContent||'')));
    if(cartTab){ cartTab.click(); clicked.push('cart-tab:'+norm(cartTab.innerText||cartTab.textContent||'')); }

    const roots=[...document.querySelectorAll('app-cart,app-cart-content,.cart-wrapper,.cart-content,.cart-tab-content,.cart-tabs-container')];
    let simple=null;
    for(const root of roots){
      simple=[...root.querySelectorAll('button,[role="button"],a')].find(el=>visible(el)&&/^Simple$/i.test(norm(el.innerText||el.textContent||'')));
      if(simple) break;
    }
    if(!simple){
      simple=[...document.querySelectorAll('button,[role="button"],a')].find(el=>{
        if(!visible(el)||!/^Simple$/i.test(norm(el.innerText||el.textContent||''))) return false;
        let cur=el.parentElement;
        for(let i=0;cur&&i<5;i++,cur=cur.parentElement){
          const t=norm(cur.innerText||cur.textContent||'');
          if(/Combin[ée]|Multiple/i.test(t)) return true;
        }
        return false;
      });
    }
    if(simple){ simple.click(); clicked.push('simple:'+norm(simple.innerText||simple.textContent||'')); }
    const cartRoot=document.querySelector('app-cart,.cart-wrapper,.cart-content');
    if(cartRoot) cartRoot.scrollIntoView({block:'nearest'});
    return {clicked,cartTabs:cartTabs.map(b=>({id:b.id||null,text:norm(b.innerText||b.textContent||''),data:b.getAttribute('data')})),simpleFound:!!simple};
  });
  await page.waitForTimeout(450);
  return info;
}

async function resetCart(page){
  await ensureSimpleMode(page);

  // V11.4.5: le reset n'est valide que si les 3 sources sont à zéro.
  const clean=async()=>({
    badge:await cartCount(page).catch(()=>-1),
    cards:await uniqueSimpleCardCount(page).catch(()=>-1),
    active:await activeOutcomeCount(page).catch(()=>-1)
  });

  let s=await clean();
  if(s.badge===0&&s.cards===0&&s.active===0) return;

  const trash=page.locator('button.svg-white-trash-dims--right').first();
  if(await trash.count()) await trash.evaluate(el=>el.click()).catch(()=>{});
  await page.waitForTimeout(300);
  const confirm=page.getByRole('button',{name:/^(OUI|CONFIRMER|VIDER|SUPPRIMER|TOUT SUPPRIMER)$/i}).first();
  if(await confirm.count()) await confirm.evaluate(el=>el.click()).catch(()=>{});

  let end=Date.now()+4500;
  while(Date.now()<end){ s=await clean(); if(s.badge===0&&s.cards===0&&s.active===0) return; await page.waitForTimeout(150); }

  // Si le panier est vide mais que des outcomeButtons restent actifs, on les
  // désactive explicitement pendant la phase RESET uniquement.
  s=await clean();
  if(s.cards===0 && (s.badge===0||s.badge===-1) && s.active>0){
    await page.evaluate(()=>{
      const truthy=v=>String(v||'').toLowerCase()==='true';
      const visible=el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
      const active=el=>{
        if(truthy(el.getAttribute('aria-pressed'))||truthy(el.getAttribute('aria-selected'))||truthy(el.getAttribute('aria-checked'))) return true;
        if(el.matches?.(':checked')||el.querySelector?.('input:checked')) return true;
        let cur=el; for(let i=0;cur&&i<3;i++,cur=cur.parentElement){ if(/(^|[\s_-])(selected|active|checked|chosen|is-selected|is-active)([\s_-]|$)/i.test(String(cur.className||''))) return true; }
        return false;
      };
      [...document.querySelectorAll('button.outcomeButton,.outcomeButton')].filter(el=>visible(el)&&active(el)).forEach(el=>(el.closest('button,[role="button"],label,a')||el).click());
    }).catch(()=>{});
    end=Date.now()+3000;
    while(Date.now()<end){ s=await clean(); if(s.badge===0&&s.cards===0&&s.active===0) return; await page.waitForTimeout(150); }
  }

  s=await clean();
  throw new Error(`Reset Parions Sport non confirmé : badge=${s.badge}, cartes=${s.cards}, cotesActives=${s.active}.`);
}





class SelectionDebugError extends Error {
  constructor(message, diagnostic){ super(message); this.name='SelectionDebugError'; this.diagnostic=diagnostic; }
}

async function findExactCartCard(page,b){
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

async function snapshotCart(page){
  return page.evaluate(() => {
    const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
    const cards=[...document.querySelectorAll('.cart-item.simple, app-bet-simple .cart-item, app-bet-simple')];
    const rows=cards.map((el,i)=>({
      i,
      tag:el.tagName,
      cls:String(el.className||'').slice(0,180),
      text:norm(el.innerText||el.textContent||'').slice(0,700),
      input:[...el.querySelectorAll('input')].slice(0,4).map(x=>({id:x.id,name:x.name,value:x.value,type:x.type}))
    }));
    const badge=[...document.querySelectorAll('[data="app-cart|nbreParisPanier"], .tabs-cart_number')]
      .map(x=>norm(x.innerText||x.textContent||''));
    return {badge, rows};
  });
}

async function inspectEventAndChoose(page,b){
  return page.evaluate(({eventNumber,home,away,outcome})=>{
    const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
    const txt=el=>norm(el?.innerText||el?.textContent||'');
    const esc=s=>String(s??'').replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&');
    const forbidden='app-cart,.cart-wrapper,.cart-content,.cart-item.simple,app-bet-simple,app-cart-content,.cart-tab-content,.cart-tabs-container,.cart-scroll';
    const isForbidden=el=>!!el?.closest?.(forbidden);
    const visible=el=>{ const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'; };
    const isActive=el=>{
      if(!el) return false;
      const truthy=v=>String(v||'').toLowerCase()==='true';
      if(truthy(el.getAttribute('aria-pressed'))||truthy(el.getAttribute('aria-selected'))||truthy(el.getAttribute('aria-checked'))) return true;
      if(el.matches?.(':checked')||el.querySelector?.('input:checked')) return true;
      for(const name of ['data-selected','data-active','data-checked','selected','active']) if(truthy(el.getAttribute?.(name))) return true;
      let cur=el; for(let i=0;cur&&i<3;i++,cur=cur.parentElement){ if(/(^|[\s_-])(selected|active|checked|chosen|is-selected|is-active)([\s_-]|$)/i.test(String(cur.className||''))) return true; }
      return false;
    };
    const describe=el=>{
      if(!el) return null;
      const r=el.getBoundingClientRect();
      return {
        tag:el.tagName, text:txt(el).slice(0,260), cls:String(el.className||'').slice(0,240),
        id:el.id||null, role:el.getAttribute('role'), ariaPressed:el.getAttribute('aria-pressed'), ariaSelected:el.getAttribute('aria-selected'),
        ariaChecked:el.getAttribute('aria-checked'), ariaLabel:el.getAttribute('aria-label'), title:el.getAttribute('title'), disabled:!!el.disabled,
        rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
        active:isActive(el), data:[...el.attributes].filter(a=>a.name.startsWith('data-')).slice(0,12).map(a=>[a.name,a.value])
      };
    };
    const all=[...document.querySelectorAll('body *')].filter(el=>!isForbidden(el));
    const eventRe=new RegExp('(?:N[°ºo]?\\s*)?'+esc(eventNumber)+'\\b','i');
    const homeRe=new RegExp(esc(home),'i'), awayRe=new RegExp(esc(away),'i');

    const seeds=all.filter(el=>{
      const t=txt(el); if(!t) return false;
      const hit=eventRe.test(t) || (homeRe.test(t)&&awayRe.test(t));
      if(!hit) return false;
      return ![...el.children].some(c=>{const ct=txt(c);return eventRe.test(ct)||(homeRe.test(ct)&&awayRe.test(ct));});
    }).slice(0,20);

    const cardCandidates=[];
    for(const seed of seeds){
      let cur=seed;
      for(let depth=0;cur&&depth<10;depth++,cur=cur.parentElement){
        if(isForbidden(cur)) break;
        const t=txt(cur);
        if(!(eventRe.test(t)||(homeRe.test(t)&&awayRe.test(t)))) continue;
        const buttons=[...cur.querySelectorAll('button,[role="button"],label,a,input[type="radio"],input[type="checkbox"]')]
          .filter(x=>!isForbidden(x)&&visible(x));
        const texts=buttons.map(x=>txt(x)+' '+(x.getAttribute('aria-label')||'')+' '+(x.value||''));
        const has1=texts.some(t=>/^\s*1(?:\s|$)/i.test(t));
        const hasN=texts.some(t=>/^\s*N(?:\s|$)/i.test(t));
        const has2=texts.some(t=>/^\s*2(?:\s|$)/i.test(t));
        if([has1,hasN,has2].filter(Boolean).length>=2){
          cardCandidates.push({el:cur,depth,text:t.slice(0,900),buttonCount:buttons.length,has1,hasN,has2});
          break;
        }
      }
    }

    const uniq=[]; const seen=new Set();
    for(const c of cardCandidates){ if(seen.has(c.el)) continue; seen.add(c.el); uniq.push(c); }
    uniq.sort((a,b)=>a.text.length-b.text.length);
    const chosenCard=uniq[0]?.el||null;
    const clickables=chosenCard?[...chosenCard.querySelectorAll('button,[role="button"],label,a,input[type="radio"],input[type="checkbox"]')].filter(x=>!isForbidden(x)&&visible(x)):[];
    const outcomeRe=new RegExp('^\\s*'+esc(outcome)+'(?:\\s|$)','i');
    const scored=clickables.map((el,idx)=>{
      const composite=txt(el)+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('title')||'')+' '+(el.value||'');
      let score=-1;
      if(outcomeRe.test(composite)) score=100;
      if(outcome==='1' && txt(el).toLowerCase().startsWith(home.toLowerCase())) score=Math.max(score,90);
      if(outcome==='2' && txt(el).toLowerCase().startsWith(away.toLowerCase())) score=Math.max(score,90);
      return {el,idx,score,composite:composite.slice(0,300),desc:describe(el)};
    }).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score||a.idx-b.idx);
    const chosen=scored[0]?.el||null;
    // V11.4.26: un seul marqueur de clic peut exister à la fois.
    // Les anciennes versions laissaient les marqueurs des matchs précédents,
    // puis clickMarkedTarget(...).first() recliquait la première cote du DOM.
    document.querySelectorAll('[data-l1-debug-target="1"]').forEach(el=>{
      el.removeAttribute('data-l1-debug-target');
      el.removeAttribute('data-l1-debug-event');
      el.removeAttribute('data-l1-debug-outcome');
    });
    if(chosen){
      chosen.setAttribute('data-l1-debug-target','1');
      chosen.setAttribute('data-l1-debug-event',String(eventNumber));
      chosen.setAttribute('data-l1-debug-outcome',String(outcome));
    }

    return {
      ok:!!chosen,
      reason: chosen?'chosen':'no-target',
      url:location.href,title:document.title,
      seeds:seeds.map(describe),
      cards:uniq.slice(0,8).map(c=>({depth:c.depth,text:c.text,buttonCount:c.buttonCount,has1:c.has1,hasN:c.hasN,has2:c.has2})),
      chosenCard:chosenCard?{text:txt(chosenCard).slice(0,1200),html:chosenCard.outerHTML.slice(0,6000)}:null,
      candidates:scored.slice(0,12).map(x=>({score:x.score,composite:x.composite,...x.desc})),
      chosen:describe(chosen)
    };
  },b);
}

async function targetState(page,b){
  const fresh=await inspectEventAndChoose(page,b).catch(()=>null);
  return {fresh,active:!!fresh?.chosen?.active,exact:!!(await findExactCartCard(page,b)),count:await uniqueSimpleCardCount(page).catch(()=>-1),badge:await cartCount(page).catch(()=>null)};
}

async function clickMarkedTarget(page,method){
  const marked=page.locator('[data-l1-debug-target="1"]');
  const markedCount=await marked.count();
  if(markedCount!==1) return {ok:false,method,reason:`target-count-${markedCount}`};
  const loc=marked.first();
  await loc.scrollIntoViewIfNeeded().catch(()=>{});
  const box=await loc.boundingBox().catch(()=>null);
  try{
    if(method==='locator') await loc.click({timeout:2500});
    else if(method==='pointer'){
      if(!box) return {ok:false,method,reason:'no-box'};
      const x=box.x+box.width/2,y=box.y+box.height/2;
      await page.mouse.move(x,y);
      await page.mouse.down();
      await page.waitForTimeout(45);
      await page.mouse.up();
    } else if(method==='dom-events'){
      await loc.evaluate(el=>{
        const r=el.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
        const common={bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true};
        for(const type of ['pointerover','mouseover','pointerenter','mouseenter','pointerdown','mousedown','pointerup','mouseup','click']){
          const C=type.startsWith('pointer')?PointerEvent:MouseEvent;
          el.dispatchEvent(new C(type,common));
        }
      });
    }
    return {ok:true,method,box};
  }catch(e){ return {ok:false,method,box,error:String(e?.message||e)}; }
}

async function fastCartCount(page){
  return page.evaluate(()=>{
    const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
    const badge=[...document.querySelectorAll('[data="app-cart|nbreParisPanier"], .tabs-cart_number')]
      .map(x=>parseInt(norm(x.innerText||x.textContent||'').replace(/\D/g,''),10))
      .find(Number.isFinite);
    if(Number.isFinite(badge)) return badge;
    const cards=[...document.querySelectorAll('.cart-item.simple')];
    const signatures=new Set(cards.map(card=>{
      const input=card.querySelector('input');
      const id=input?.id||input?.getAttribute('name')||'';
      const text=norm(card.innerText||card.textContent||'');
      return id?`id:${id}`:`txt:${text}`;
    }));
    return signatures.size;
  });
}

async function cartStakeInputIds(page){
  return page.evaluate(()=>{
    const ids=[];
    const seen=new Set();
    const exact=[...document.querySelectorAll('input[id^="bet-input-"]')];
    const fallback=[...document.querySelectorAll('app-cart input,app-cart-content input,.cart-wrapper input,.cart-content input')]
      .filter(input=>{
        const type=String(input.type||'text').toLowerCase();
        const ph=String(input.placeholder||'');
        const name=String(input.name||'');
        return !['hidden','radio','checkbox','submit','button','search'].includes(type) && (type==='number'||type==='tel'||type==='text'||/mise|stake|montant|€/i.test(ph+' '+name));
      });
    for(const input of [...exact,...fallback]){
      const key=input.id||input.name||`anon-${ids.length}`;
      if(seen.has(key)) continue;
      seen.add(key);
      ids.push(input.id||key);
    }
    return ids;
  });
}

async function cartDomDebug(page){
  return page.evaluate(()=>{
    const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
    const desc=el=>({tag:el.tagName,id:el.id||null,cls:String(el.className||'').slice(0,140),text:norm(el.innerText||el.textContent||'').slice(0,500),data:el.getAttribute('data')});
    return {
      badge:[...document.querySelectorAll('[data="app-cart|nbreParisPanier"],.tabs-cart_number')].map(desc),
      tabs:[...document.querySelectorAll('button.tabs-cart_btn')].map(desc),
      simpleButtons:[...document.querySelectorAll('button,[role="button"],a')].filter(x=>/^Simple$/i.test(norm(x.innerText||x.textContent||''))).map(desc).slice(0,10),
      roots:[...document.querySelectorAll('app-cart,app-cart-content,.cart-wrapper,.cart-content,.cart-tab-content,.cart-tabs-container,app-bet-simple')].map(desc).slice(0,20),
      inputs:[...document.querySelectorAll('input')].map(x=>({id:x.id||null,name:x.name||null,type:x.type||null,value:x.value||null,placeholder:x.placeholder||null,parent:x.parentElement?.tagName||null})).slice(0,40)
    };
  });
}

async function stakeInputForBet(page,b,index=null){
  const card=await findExactCartCard(page,b);
  if(card){
    const input=card.locator('input[id^="bet-input-"], input').first();
    if(await input.count()) return input;
  }
  const idx=Number.isInteger(index)?index:(Number.isInteger(b?._cartIndex)?b._cartIndex:null);
  if(idx!==null){
    const inputs=page.locator('input[id^="bet-input-"], app-cart input[type="number"], app-cart-content input[type="number"], .cart-wrapper input[type="number"], .cart-content input[type="number"]');
    if(await inputs.count()>idx) return inputs.nth(idx);
  }
  if(b?._stakeInputId && String(b._stakeInputId).startsWith('bet-input-')){
    const id=String(b._stakeInputId).replace(/"/g,'\\"');
    const loc=page.locator(`input[id="${id}"]`).first();
    if(await loc.count()) return loc;
  }
  return null;
}

async function waitCartAtLeast(page,minCount,timeoutMs){
  const end=Date.now()+timeoutMs;
  let last=0;
  while(Date.now()<end){
    if(page.isClosed()) throw new Error('BROWSERLESS_PAGE_CLOSED_DURING_CART_WAIT');
    last=await fastCartCount(page);
    if(last>=minCount) return last;
    await page.waitForTimeout(90);
  }
  return await fastCartCount(page);
}

async function ensureUniqueSelection(page,b){
  if(await findExactCartCard(page,b)) return {via:'cart-existing'};

  const diagnostic={version:'11.4.26',bet:{eventNumber:b.eventNumber,home:b.home,away:b.away,outcome:b.outcome,stake:b.stake},before:null,inspect:null,attempts:[]};
  const before=await fastCartCount(page);
  const beforeInputIds=await cartStakeInputIds(page);
  diagnostic.before={count:before,inputIds:beforeInputIds};

  let inspect=await inspectEventAndChoose(page,b);
  diagnostic.inspect=inspect;
  if(!inspect?.ok) throw new SelectionDebugError(`DEBUG N°${b.eventNumber} ${b.outcome}: aucune cible déterministe trouvée.`,diagnostic);
  if(inspect?.chosen?.active) return {via:'active-existing',diagnostic};

  for(const [method,waitMs] of [['locator',1200],['pointer',850],['dom-events',850]]){
    inspect=await inspectEventAndChoose(page,b);
    if(!inspect?.ok) break;
    if(inspect?.chosen?.active) return {via:'active-before-'+method,diagnostic};
    if(await findExactCartCard(page,b)) return {via:'cart-before-'+method,diagnostic};

    const click=await clickMarkedTarget(page,method);
    const attempt={method,click};
    diagnostic.attempts.push(attempt);
    if(!click?.ok) continue;

    const after=await waitCartAtLeast(page,before+1,waitMs);
    attempt.afterCount=after;
    if(after>=before+1){
      const afterInputIds=await cartStakeInputIds(page);
      const stakeInputId=afterInputIds.find(id=>!beforeInputIds.includes(id))||null;
      attempt.stakeInputId=stakeInputId;
      return {via:'cart-count-'+method,diagnostic,stakeInputId};
    }

    if(await findExactCartCard(page,b)) return {via:'cart-'+method,diagnostic};
    const verify=await inspectEventAndChoose(page,b).catch(()=>null);
    if(verify?.chosen?.active) return {via:'active-'+method,diagnostic};
  }

  diagnostic.after={count:await fastCartCount(page).catch(()=>null),cart:await snapshotCart(page).catch(()=>null)};
  const chosen=diagnostic.inspect?.chosen;
  throw new SelectionDebugError(`DEBUG N°${b.eventNumber} ${b.outcome}: activation non confirmée. cible=${chosen?.tag||'?'} ${JSON.stringify(chosen?.text||'')} panier=${before}→${diagnostic.after.count}; méthodes=${diagnostic.attempts.map(a=>a.method).join(',')}`,diagnostic);
}

async function selectionConfirmed(page,b){
  if(await findExactCartCard(page,b)) return true;
  const fresh=await inspectEventAndChoose(page,b).catch(()=>null);
  return !!fresh?.chosen?.active;
}




const PS_URL = 'https://www.pointdevente.parionssport.fdj.fr/paris-ouverts/football/l1-mcdonald-s/45452';

async function setStake(page,b,index){
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

async function validateAndQr(page,bets){
  const uniqueCount=await uniqueSimpleCardCount(page);
  if(uniqueCount!==bets.length) throw new Error(`Contrôle panier : ${uniqueCount} carte(s) Simple unique(s) pour ${bets.length} sélection(s) attendue(s).`);
  let total=0;
  for(let i=0;i<bets.length;i++){ const b=bets[i]; const input=await stakeInputForBet(page,b,i); if(!input) throw new Error(`Contrôle final impossible pour N°${b.eventNumber} ${b.outcome} (index=${i}, inputId=${b._stakeInputId||'aucun'}).`); const v=Number(await input.inputValue()); if(Math.abs(v-Number(b.stake))>.001) throw new Error(`Contrôle de mise incorrect pour N°${b.eventNumber} ${b.outcome}.`); total+=v; }
  const validateInfo = await page.evaluate(() => {
    const norm = s => String(s || '').replace(/\s+/g,' ').trim();
    const candidates = [...document.querySelectorAll('app-cart-content button, .cart-wrapper button, .cart-content button, button.button')];
    for (const btn of candidates) {
      if (norm(btn.innerText || btn.textContent).toUpperCase() !== 'VALIDER') continue;
      const card = btn.closest('div.card') || btn.closest('app-cart-content') || btn.closest('.cart-content');
      const ctx = norm(card?.innerText || card?.textContent || '');
      if (!/Sélection/i.test(ctx) || !/Simple/i.test(ctx)) continue;
      if (btn.disabled) continue;
      btn.scrollIntoView({block:'center'});
      btn.setAttribute('data-l1maggle-validate','1');
      return {ok:true, context:ctx.slice(0,500)};
    }
    return {ok:false, buttons:candidates.map(b=>norm(b.innerText||b.textContent)).filter(Boolean).slice(-30)};
  });
  if (!validateInfo.ok) throw new Error('Bouton VALIDER introuvable dans le panier Simple. Boutons visibles : ' + (validateInfo.buttons||[]).join(' | '));
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-l1maggle-validate="1"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error('Bouton VALIDER détecté mais clic DOM impossible.');
  // V11.4.26 : après VALIDER, le site affiche une action "QR CODE" dans
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

  // V11.4.26: le QR officiel n'est plus supposé être uniquement un <img>
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
  throw new Error(`QR Code officiel introuvable après validation. debug=${JSON.stringify(qrDebug)}`);
}
async function createBulletin(page,inputBets){
  const startedAt=Date.now();
  let stage='résolution des numéros Parions Sport';
  const elapsed=()=>((Date.now()-startedAt)/1000).toFixed(1);
  try{
    let events=[];
    if((inputBets||[]).some(b=>!Number(b.eventNumber))){
      events=await fetchParionsL1EventsHttp();
    }
    const resolved=(inputBets||[]).map(b=>{
      if(Number(b.eventNumber)) return {...b,eventNumber:Number(b.eventNumber)};
      let e=(events||[]).find(x=>sameTeam(b.home,x.home)&&sameTeam(b.away,x.away));
      if(!e) e=(events||[]).find(x=>sameTeam(b.home,x.away)&&sameTeam(b.away,x.home));
      if(!e) throw new Error(`Correspondance Parions Sport introuvable pour ${b.home} – ${b.away}. Événements détectés: ${(events||[]).length}.`);
      return {...b,eventNumber:e.eventNumber};
    });
    const bets=aggregateBets(resolved);

    stage='ouverture Parions Sport';
    await page.goto(PS_URL, {waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForTimeout(700);
    await dismissPrivacyOverlay(page);
    await page.waitForTimeout(250);

    stage='passage en mode Simple';
    await ensureSimpleMode(page);
    stage='réinitialisation du panier';
    await resetCart(page);

    for(let i=0;i<bets.length;i++){
      stage=`sélection ${i+1}/${bets.length} · N°${bets[i].eventNumber} ${bets[i].outcome}`;
      const selected=await ensureUniqueSelection(page,bets[i]);
      if(selected?.stakeInputId) bets[i]._stakeInputId=selected.stakeInputId;
    }

    stage='ouverture panier Simple';
    const simpleState=await ensureSimpleMode(page);
    stage='binding final des mises';
    let stakeIds=[];
    const bindEnd=Date.now()+4500;
    while(Date.now()<bindEnd){
      stakeIds=await cartStakeInputIds(page);
      if(stakeIds.length===bets.length) break;
      await page.waitForTimeout(120);
    }
    if(stakeIds.length!==bets.length){
      const snap=await snapshotCart(page).catch(()=>null);
      const dom=await cartDomDebug(page).catch(()=>null);
      throw new Error(`Binding des mises : ${stakeIds.length} champ(s) pour ${bets.length} pari(s). simple=${JSON.stringify(simpleState)} inputs=${JSON.stringify(stakeIds)} panier=${JSON.stringify(snap?.rows?.map(r=>({text:r.text,input:r.input}))||[])} dom=${JSON.stringify(dom)}`);
    }
    for(let i=0;i<bets.length;i++){
      bets[i]._cartIndex=i;
      bets[i]._stakeInputId=stakeIds[i];
    }

    stage='contrôle final des sélections';
    await page.waitForTimeout(250);
    for(const b of bets){
      if(!await selectionConfirmed(page,b))
        throw new Error(`Contrôle des sélections : N°${b.eventNumber} ${b.outcome} n’est confirmée ni par le panier ni par la cote active.`);
    }

    stage='application des mises';
    for(let i=0;i<bets.length;i++) await setStake(page,bets[i],i);
    stage='validation et QR';
    return await validateAndQr(page,bets);
  }catch(e){
    if(e && typeof e==='object' && !String(e.message||'').startsWith('[étape ')){
      e.message=`[étape ${stage} · ${elapsed()} s] ${e.message||String(e)}`;
    }
    throw e;
  }
}





export const config = { maxDuration: 300 };

function isTargetClosedError(e){
  return /Target page, context or browser has been closed|Target closed|Browser has been closed|Protocol error.*closed/i.test(String(e?.message||e||''));
}

export default async function handler(req,res){
  try{
    const action=String(req.query?.action||'health');
    if(action==='health') return res.status(200).json({ok:true,version:'11.4.26',browserlessConfigured:browserlessConfigured()});
    if(action==='debug-sync'){
      if(!browserlessConfigured()) return res.status(503).json({ok:false,error:'BROWSERLESS_NOT_CONFIGURED'});
      const browser=await openRemoteBrowser();
      try{
        const page=await getPage(browser);
        let events=[];
        try{ events=await fetchParionsL1EventsHttp(); }
        catch(e){ console.error('PARIONS_MAPPING_HTTP_FAILED '+String(e?.message||e)); }
        const raw=await scrapeLigue1Maggle(page,events);
        const data=attachParionsNumbers(raw,events);
        const pickCounts={};
        for(const m of data.matchs||[]) for(const [player,pick] of Object.entries(m.pronostics||{})) if(['1','N','2'].includes(pick)) pickCounts[player]=(pickCounts[player]||0)+1;
        return res.status(200).json({ok:true,version:'11.4.26',journee:data.journee,classement:data.classement,matches:(data.matchs||[]).map(m=>({home:m.domicile,away:m.exterieur,eventNumber:m.eventNumber,parionsMatch:m.parionsMatch,validPicks:Object.values(m.pronostics||{}).filter(x=>['1','N','2'].includes(x)).length})),parionsEvents:data.parionsEvents,mappingDiagnostics:data.mappingDiagnostics,pickCounts});
      }finally{ await browser.close().catch(()=>{}); }
    }
    if(req.method!=='POST') return res.status(405).json({ok:false,error:'POST requis'});
    if(!browserlessConfigured()) return res.status(503).json({ok:false,error:'BROWSERLESS_NOT_CONFIGURED'});
    if(action==='create-bulletin'){
      const bets=req.body?.bets;
      if(!Array.isArray(bets)||!bets.length) return res.status(400).json({ok:false,error:'Aucun pari reçu'});
      let lastError=null;
      for(let attempt=1;attempt<=2;attempt++){
        let retryBrowser=null, retryPage=null;
        try{
          retryBrowser=await openRemoteBrowser();
          retryPage=await getPage(retryBrowser);
          const result=await createBulletin(retryPage, bets);
          return res.status(200).json({ok:true,...result});
        }catch(e){
          lastError=e;
          if(attempt<2 && isTargetClosedError(e)){
            console.warn(`BROWSERLESS_TARGET_CLOSED_RETRY attempt=${attempt} ${String(e?.message||e)}`);
          }else{
            throw e;
          }
        }finally{
          if(retryPage && !retryPage.isClosed()) await retryPage.close().catch(()=>{});
          if(retryBrowser?.isConnected()) await retryBrowser.close().catch(()=>{});
        }
      }
      throw lastError||new Error('BROWSERLESS_RETRY_FAILED');
    }
    const browser=await openRemoteBrowser();
    try{
      const page=await getPage(browser);
      if(action==='sync'){
        let events=[];
        try{ events=await fetchParionsL1EventsHttp(); }
        catch(e){ console.error('PARIONS_MAPPING_HTTP_FAILED '+String(e?.message||e)); }
        const data=await scrapeLigue1Maggle(page,events);
        const mapped=attachParionsNumbers(data,events);
        if(events.length && mapped.mappingDiagnostics?.mapped<1){
          throw new Error(`Synchronisation Ligue1Maggle incohérente : aucun match Ligue1Maggle ne correspond aux paris Ligue 1 actuellement ouverts.`);
        }
        return res.status(200).json({ok:true,data:mapped});
      }
      if(action==='create-bulletin'){
        const bets=req.body?.bets; if(!Array.isArray(bets)||!bets.length) return res.status(400).json({ok:false,error:'Aucun pari reçu'});
        return res.status(200).json({ok:true,...await createBulletin(page,bets)});
      }
      return res.status(404).json({ok:false,error:'Action inconnue'});
    }finally{ await browser.close().catch(()=>{}); }
  }catch(e){ const diagnostic=e?.diagnostic||null; if(diagnostic) console.error('SELECTION_DIAGNOSTIC '+JSON.stringify(diagnostic)); return res.status(500).json({ok:false,error:e?.message||String(e),diagnostic}); }
}
