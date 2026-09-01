from pathlib import Path

p=Path('api/index.js')
s=p.read_text()

s=s.replace("      if(rows.length<3 || !rows.some(r=>/\\bvs\\b/i.test(txt(r)))) return null;","      if(rows.length<2 || !rows.some(r=>/\\bvs\\b/i.test(txt(r)))) return null;",1)
s=s.replace("      if(matchs.length<5) return null;","      if(!matchs.length) return null;",1)

a=s.index('    async function tryAdvanceJournee(currentJournee){')
z=s.index('\n    const knownPlayers=p.joueurs;',a)
replacement=r'''    function betterCandidate(a,b){
      if(!a) return b;
      if(!b) return a;
      if((b.overlap||0)!==(a.overlap||0)) return (b.overlap||0)>(a.overlap||0)?b:a;
      if(Number(!!b.visible)!==Number(!!a.visible)) return b.visible?b:a;
      if((b.journee||0)!==(a.journee||0)) return (b.journee||0)>(a.journee||0)?b:a;
      return (b.matchs?.length||0)>(a.matchs?.length||0)?b:a;
    }

    async function probeCurrentMatchday(){
      let best=extractPronostics();
      const probes=[];
      const record=(label,c)=>{
        probes.push({label,journee:c?.journee??null,overlap:c?.overlap||0,visible:!!c?.visible,matchs:c?.matchs?.map(m=>`${m.domicile}-${m.exterieur}`)||[]});
        best=betterCandidate(best,c);
      };
      const targetCount=Array.isArray(targetEvents)?targetEvents.length:0;
      const enough=c=>targetCount>0 && (c?.overlap||0)>=Math.min(targetCount,Math.max(1,c?.matchs?.length||1));
      record('initial',best);
      if(enough(best)) return {...best,probeDiagnostics:probes};

      const isRoundSelect=sel=>{
        const meta=norm([sel.id,sel.name,sel.className,sel.getAttribute('aria-label')].filter(Boolean).join(' '));
        const opts=[...sel.options].map(o=>txt(o));
        return /jour|round|week|matchday/i.test(meta) || opts.filter(t=>/JOURN[ÉE]E?|^J\s*\d+|^\d{1,2}$/i.test(t)).length>=2;
      };
      const selectCount=[...document.querySelectorAll('select')].filter(visible).filter(isRoundSelect).length;
      for(let si=0;si<selectCount;si++){
        const initialSel=[...document.querySelectorAll('select')].filter(visible).filter(isRoundSelect)[si];
        if(!initialSel) continue;
        const options=[...initialSel.options].map(o=>({value:o.value,text:txt(o)}));
        for(const o of options){
          const sel=[...document.querySelectorAll('select')].filter(visible).filter(isRoundSelect)[si];
          if(!sel) continue;
          sel.value=o.value;
          sel.dispatchEvent(new Event('input',{bubbles:true}));
          sel.dispatchEvent(new Event('change',{bubbles:true}));
          await sleep(350);
          const c=extractPronostics(); record(`select:${si}:${o.text}`,c);
          if(enough(c)) return {...c,probeDiagnostics:probes};
        }
      }

      const roundControls=()=>[...document.querySelectorAll('button,a,[role="button"]')].filter(el=>{
        if(!visible(el)) return false;
        const t=txt(el);
        const meta=norm([t,el.id,el.className,el.getAttribute('aria-label'),el.getAttribute('title')].filter(Boolean).join(' '));
        if(/journ[ée]e|matchday|round|week|semaine/i.test(meta)) return true;
        if(!/^(?:J(?:OURN[ÉE]E?)?\s*)?\d{1,2}$/i.test(t)) return false;
        let cur=el.parentElement;
        for(let d=0;cur&&d<4;d++,cur=cur.parentElement){
          const ctx=norm([cur.id,cur.className,txt(cur)].filter(Boolean).join(' '));
          if(/journ[ée]e|matchday|round|week|semaine/i.test(ctx)) return true;
        }
        return false;
      });
      const labels=[...new Set(roundControls().map(el=>norm([txt(el),el.getAttribute('aria-label'),el.getAttribute('title')].filter(Boolean).join(' '))).filter(Boolean))];
      for(const label of labels){
        const el=roundControls().find(x=>norm([txt(x),x.getAttribute('aria-label'),x.getAttribute('title')].filter(Boolean).join(' '))===label);
        if(!el) continue;
        try{el.click();}catch{continue;}
        await sleep(380);
        const c=extractPronostics(); record(`control:${label}`,c);
        if(enough(c)) return {...c,probeDiagnostics:probes};
      }

      for(let step=0;step<10;step++){
        const next=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible).find(el=>{
          const t=norm([txt(el),el.getAttribute('aria-label'),el.getAttribute('title')].filter(Boolean).join(' '));
          return /(?:journ[ée]e?.*)?(suiv|next|prochain)|^(?:>|›|»|→)$/i.test(t);
        });
        if(!next) break;
        next.click(); await sleep(380);
        const c=extractPronostics(); record(`next:${step+1}`,c);
        if(enough(c)) return {...c,probeDiagnostics:probes};
      }
      return {...best,probeDiagnostics:probes};
    }

    let p=await probeCurrentMatchday();
    p.diagnostics={...(p.diagnostics||{}),probes:p.probeDiagnostics||[]};
'''
s=s[:a]+replacement+s[z:]

old="""        if(events.length && mapped.mappingDiagnostics?.mapped<1){\n          throw new Error(`Synchronisation Ligue1Maggle incohérente : aucun match Ligue1Maggle ne correspond aux paris Ligue 1 actuellement ouverts.`);\n        }\n"""
new="""        if(events.length && mapped.mappingDiagnostics?.mapped<1){\n          const probes=(mapped.sourceDiagnostics?.probes||[]).map(p=>`${p.label}[J${p.journee??'?'}:${p.overlap}]`).join(' > ');\n          throw new Error(`Synchronisation Ligue1Maggle incohérente : aucun match Ligue1Maggle ne correspond aux paris Ligue 1 actuellement ouverts. Navigation testée: ${probes||'aucun contrôle de journée détecté'}.`);\n        }\n"""
if old not in s:
    raise SystemExit('guard block not found')
s=s.replace(old,new,1)

s=s.replace('11.4.26','11.4.27')
p.write_text(s)

p=Path('index.html')
p.write_text(p.read_text().replace('V11.4.26','V11.4.27'))
p=Path('package.json')
p.write_text(p.read_text().replace('"version":"11.4.26"','"version":"11.4.27"'))
