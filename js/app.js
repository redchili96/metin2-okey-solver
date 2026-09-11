import { COLORS, CARD_BY_ID, unseenCards, actionLabel, cardLabel, createGame } from './game.js';
import { saveGame, getGames, getLatestActiveGame, importGames, deleteGame } from './storage.js';
import { queueGameTelemetry, flushTelemetryQueue } from './telemetry.js';

const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
let game = null;
let historyStack = [];
let latestRanking = [];
let latestSolverMeta = null;
let worker = null;
let analysisStartedAt = 0;
let analysisTimer = null;
let activeAnalysisSeed = null;
let activeAnalysisKey = null;
let completedAnalysisKey = null;
let pendingDiscardRow = null;
let safeDiscardMode = true;

function clone(value){ return structuredClone(value); }
function fmtDate(iso){ return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(iso)); }
function avg(values){ return values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0; }
function currentSolverMode(){ return els['precision-select'].selectedOptions?.[0]?.textContent?.trim().toLowerCase() || 'strong'; }
function currentUnseenCount(){ return unseenCards(game.hand,game.used).length; }
function canAnalyzeCurrentState(){
  const unseenCount=currentUnseenCount();
  return game.hand.length>0 && game.pendingDraws===0 && (game.hand.length===5 || unseenCount===0);
}
function currentAnalysisKey(){
  return JSON.stringify({
    hand:[...game.hand].sort(),
    used:[...game.used].sort(),
    score:game.score,
    simulations:Number(els['precision-select'].value||800),
  });
}
function formatCards(ids){ return (ids||[]).map(cardLabel).join(' · '); }
function sameAction(a,b){
  if(!a||!b||a.type!==b.type||Number(a.score||0)!==Number(b.score||0))return false;
  const ac=[...(a.cards||[])].sort(),bc=[...(b.cards||[])].sort();
  return ac.length===bc.length && ac.every((id,i)=>id===bc[i]);
}
function loadSafeMode(){
  try{return localStorage.getItem('m2-safe-discard')!=='off';}catch{return true;}
}
function saveSafeMode(){
  try{localStorage.setItem('m2-safe-discard',safeDiscardMode?'on':'off');}catch{}
}

function initWorker(){
  worker?.terminate();
  worker = new Worker('./js/solver-worker.js');
  worker.onmessage = event => {
    const msg = event.data;
    if(msg.type==='error'){
      if(msg.seed && msg.seed!==activeAnalysisSeed)return;
      activeAnalysisSeed=null;
      activeAnalysisKey=null;
      els['solver-status'].textContent=`Calculation failed: ${msg.message}`;
      return;
    }
    if(msg.type==='result'){
      if(msg.seed!==activeAnalysisSeed || activeAnalysisKey!==currentAnalysisKey())return;
      latestRanking=msg.ranked;
      latestSolverMeta={
        solverSeed:msg.seed,
        simulationsPerAction:Number(msg.simulationsPerAction||0),
        simulationCount:Number(els['precision-select'].value||0),
        solverMode:currentSolverMode(),
        computeTimeMs:Math.max(0,Math.round(performance.now()-analysisStartedAt)),
      };
      completedAnalysisKey=activeAnalysisKey;
      activeAnalysisSeed=null;
      activeAnalysisKey=null;
      renderSummary();
      renderHand();
      renderRanking();
      els['solver-status'].textContent='Recommendation ready.';
    }
  };
}

function snapshot(){ historyStack.push(clone(game)); if(historyStack.length>30)historyStack.shift(); }
async function persist(){ if(game) await saveGame(game); }

function setView(name){
  document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.view===name));
  document.querySelectorAll('.view').forEach(view=>view.classList.toggle('active',view.id===`view-${name}`));
  if(name==='history') renderHistory();
  if(name==='stats') renderStats();
}

document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>setView(tab.dataset.view)));

function renderCards(){
  const grid=els['card-grid'];grid.innerHTML='';
  for(const color of COLORS){
    const row=document.createElement('div');row.className='card-row';
    const label=document.createElement('div');label.className='row-label';label.textContent=color.label;row.appendChild(label);
    for(let v=1;v<=8;v++){
      const id=`${color.code}${v}`,button=document.createElement('button');
      button.type='button';button.className=`card ${color.css}`;button.textContent=String(v);button.setAttribute('aria-label',`${v} (${color.label})`);
      if(game.hand.includes(id))button.classList.add('selected');
      if(game.used.includes(id)){button.classList.add('used');button.disabled=true;}
      button.addEventListener('click',()=>toggleCard(id));row.appendChild(button);
    }
    grid.appendChild(row);
  }
}

function renderHand(){
  const host=els['hand-slots'];host.innerHTML='';
  const best=latestRanking[0];
  const recommendedCards=new Set(best?.action?.cards||[]);
  for(let i=0;i<5;i++){
    const id=game.hand[i];
    if(!id){const slot=document.createElement('div');slot.className='slot empty';slot.textContent='Empty';host.appendChild(slot);continue;}
    const card=CARD_BY_ID[id],slot=document.createElement('div');slot.className='slot';
    const button=document.createElement('button');button.type='button';button.className=`card ${card.css}`;button.textContent=String(card.value);button.setAttribute('aria-label',cardLabel(id));
    if(recommendedCards.has(id)){
      button.classList.add('recommended-move');
      button.dataset.move=best.action.type==='discard'?'DISCARD':'PLAY';
    }
    button.title=best?`${cardLabel(id)} — right-click to record a discard · left-click to correct`:`${cardLabel(id)} — click to correct/remove`;
    button.addEventListener('click',()=>toggleCard(id));
    button.addEventListener('contextmenu',event=>{event.preventDefault();void requestDiscard(id);});
    slot.appendChild(button);host.appendChild(slot);
  }
}

function renderSummary(){
  const unseenCount=currentUnseenCount();
  const best=latestRanking[0];
  els['score-value'].textContent=String(game.score);
  els['hand-count'].textContent=`${game.hand.length} / 5`;
  els['unseen-count'].textContent=String(unseenCount);
  els['used-count'].textContent=String(game.used.length);
  els['end-game-btn'].disabled=game.turns.length===0;
  if(game.pendingDraws>0){
    els['table-hint'].textContent=`Add ${game.pendingDraws} newly drawn card${game.pendingDraws===1?'':'s'}.`;
  }else if(game.hand.length===0 && unseenCount===0){
    els['table-hint'].textContent='All cards used. End & save the game.';
  }else if(best?.action?.type==='discard'){
    els['table-hint'].textContent=`Recommended: ${actionLabel(best.action)}. Right-click the card you actually discarded in Metin2.`;
  }else if(best?.action?.type==='play'){
    els['table-hint'].textContent='Recommended combination highlighted. Confirm it below if you played it.';
  }else if(game.hand.length<5 && unseenCount===0){
    els['table-hint'].textContent=`Final hand · ${game.hand.length} card${game.hand.length===1?'':'s'} left.`;
  }else if(game.hand.length<5){
    els['table-hint'].textContent=`Select ${5-game.hand.length} more card${5-game.hand.length===1?'':'s'} from Metin2.`;
  }else{
    els['table-hint'].textContent='Hand ready.';
  }
}

function clearRanking(message='Waiting for your hand…'){
  if(analysisTimer){clearTimeout(analysisTimer);analysisTimer=null;}
  activeAnalysisSeed=null;
  activeAnalysisKey=null;
  completedAnalysisKey=null;
  latestRanking=[];
  latestSolverMeta=null;
  els['solver-results'].innerHTML='';
  els['solver-status'].textContent=message;
}

function scheduleAutoAnalysis(){
  if(!canAnalyzeCurrentState())return;
  const key=currentAnalysisKey();
  if(activeAnalysisKey===key || completedAnalysisKey===key)return;
  if(analysisTimer)clearTimeout(analysisTimer);
  analysisTimer=setTimeout(()=>{
    analysisTimer=null;
    startAutomaticAnalysis(key);
  },80);
}

function startAutomaticAnalysis(expectedKey){
  if(!canAnalyzeCurrentState() || currentAnalysisKey()!==expectedKey)return;
  activeAnalysisKey=expectedKey;
  activeAnalysisSeed=globalThis.crypto?.randomUUID?.() || `seed-${Date.now()}-${Math.random()}`;
  els['solver-status'].textContent='Calculating best move…';
  els['solver-results'].innerHTML='';
  analysisStartedAt=performance.now();
  worker.postMessage({
    type:'analyze',
    state:{hand:game.hand,used:game.used,score:game.score},
    simulations:Number(els['precision-select'].value),
    seed:activeAnalysisSeed,
  });
}

function render(){
  renderSummary();
  renderHand();
  renderCards();
  scheduleAutoAnalysis();
}

async function toggleCard(id){
  if(game.used.includes(id))return;
  const existing=game.hand.indexOf(id);
  if(existing>=0){
    snapshot();game.hand.splice(existing,1);game.pendingDraws=0;clearRanking();await persist();render();return;
  }
  if(game.hand.length>=5)return;
  snapshot();game.hand.push(id);
  if(game.pendingDraws>0){
    game.pendingDraws--;
    const last=game.turns.at(-1);
    if(last)last.draws.push(id);
  }
  clearRanking(canAnalyzeCurrentState()?'Preparing recommendation…':'Add the remaining cards.');
  await persist();render();
}

async function requestDiscard(id){
  if(!game.hand.includes(id))return;
  if(game.pendingDraws>0){
    els['solver-status'].textContent='Add the replacement card before recording another move.';
    return;
  }
  if(!latestRanking.length){
    els['solver-status'].textContent=canAnalyzeCurrentState()?'Recommendation is still calculating…':'Complete the hand first.';
    return;
  }
  const row=latestRanking.find(item=>item.action?.type==='discard' && item.action.cards?.[0]===id);
  if(!row){
    els['solver-status'].textContent='That discard is not available in the current hand.';
    return;
  }
  if(!safeDiscardMode){
    await applyMove(row);
    return;
  }
  pendingDiscardRow=row;
  const best=latestRanking[0];
  els['discard-dialog-title'].textContent=`Discard ${cardLabel(id)}?`;
  if(sameAction(best.action,row.action)){
    els['discard-dialog-copy'].textContent='This matches the recommended move.';
  }else{
    els['discard-dialog-copy'].textContent=`Recommended: ${actionLabel(best.action)} You selected: ${actionLabel(row.action)}.`;
  }
  if(typeof els['discard-dialog'].showModal==='function')els['discard-dialog'].showModal();
  else{
    const confirmed=confirm(`${els['discard-dialog-title'].textContent}\n\n${els['discard-dialog-copy'].textContent}`);
    const selected=pendingDiscardRow;pendingDiscardRow=null;if(confirmed&&selected)await applyMove(selected);
  }
}

function renderRanking(){
  const best=latestRanking[0];
  const host=els['solver-results'];host.innerHTML='';
  if(!best)return;
  const card=document.createElement('article');card.className='result-card best';
  const ci=Math.max(1,1.96*best.se);
  card.innerHTML=`<div class="result-top"><div><div class="result-rank">BEST MOVE</div><div class="result-title">${actionLabel(best.action)}</div></div><span class="badge">RECOMMENDED</span></div><div class="result-metrics"><div><span>Expected remaining</span><strong>${best.mean.toFixed(1)} ± ${ci.toFixed(1)}</strong></div><div><span>Projected final</span><strong>${(game.score+best.mean).toFixed(1)}</strong></div><div><span>Calculation</span><strong>EV Search</strong></div></div>`;
  if(best.action.type==='discard'){
    const note=document.createElement('p');note.className='move-instruction';note.textContent='Right-click the card you actually discarded in Metin2.';card.appendChild(note);
  }else{
    const button=document.createElement('button');button.type='button';button.className='primary';button.textContent='Confirm combination played';button.addEventListener('click',()=>applyMove(best));card.appendChild(button);
  }
  host.appendChild(card);
}

async function applyMove(selectedRow){
  snapshot();
  const before={score:game.score,hand:[...game.hand],used:[...game.used]};
  const best=latestRanking[0] || selectedRow;
  const turn={
    turn:game.turns.length+1,
    timestamp:new Date().toISOString(),
    before,
    ranking:latestRanking.map(r=>({action:r.action,expectedRemaining:r.mean,se:r.se})),
    recommended:best.action,
    recommendedEV:best.mean,
    chosen:selectedRow.action,
    chosenEV:selectedRow.mean,
    regret:Math.max(0,best.mean-selectedRow.mean),
    draws:[],
    points:selectedRow.action.score,
    solverSeed:latestSolverMeta?.solverSeed||null,
    solverMode:latestSolverMeta?.solverMode||currentSolverMode(),
    simulationCount:latestSolverMeta?.simulationCount||Number(els['precision-select'].value||0),
    simulationsPerAction:latestSolverMeta?.simulationsPerAction||0,
    computeTimeMs:latestSolverMeta?.computeTimeMs??null,
  };
  game.turns.push(turn);
  game.hand=game.hand.filter(id=>!selectedRow.action.cards.includes(id));
  game.used=[...game.used,...selectedRow.action.cards];
  game.score+=selectedRow.action.score;
  game.pendingDraws=Math.min(5-game.hand.length,currentUnseenCount());

  const unseenCount=currentUnseenCount();
  let nextMessage;
  if(game.hand.length===0 && unseenCount===0){
    nextMessage='All cards used. End & save the game.';
  }else if(game.pendingDraws>0){
    nextMessage=selectedRow.action.type==='play'?`+${selectedRow.action.score} points. Add the replacement cards.`:'Discard recorded. Add the replacement card.';
  }else if(unseenCount===0){
    nextMessage=selectedRow.action.type==='play'?`+${selectedRow.action.score} points. Preparing final recommendation…`:'Discard recorded. Preparing final recommendation…';
  }else{
    nextMessage='Preparing recommendation…';
  }
  clearRanking(nextMessage);
  await persist();render();
}

async function archiveForTelemetry(archivedGame){
  try{
    await queueGameTelemetry(archivedGame);
    void flushTelemetryQueue();
  }catch(error){
    console.warn('Telemetry queue error',error);
  }
}

async function newGame(){
  if(game?.turns?.length && !confirm('Start a new game? The current game will remain saved in History.'))return;
  if(game && game.status==='active' && game.turns.length){
    game.status='abandoned';game.endedAt=new Date().toISOString();await persist();
    await archiveForTelemetry(clone(game));
  }
  game=createGame();historyStack=[];clearRanking('Enter 5 cards to begin.');await persist();render();
}

async function endGame(){
  if(!confirm(`Finish this game with ${game.score} points?`))return;
  snapshot();game.status='completed';game.endedAt=new Date().toISOString();await persist();
  await archiveForTelemetry(clone(game));
  await renderHistory();await renderStats();setView('history');
  game=createGame();historyStack=[];await persist();render();clearRanking('Enter 5 cards to begin.');
}

async function undo(){
  const previous=historyStack.pop();if(!previous){els['solver-status'].textContent='Nothing to undo.';return;}
  game=previous;clearRanking('Previous state restored.');await persist();render();
}

function gameSummaryHtml(g){
  const regrets=g.turns?.map(t=>Number(t.regret)||0)||[];
  const totalRegret=regrets.reduce((a,b)=>a+b,0);
  return `<div class="history-head"><div><div class="history-title">${g.status==='completed'?'Completed':'Saved'} game — ${g.score} pts</div><div class="history-meta">${fmtDate(g.startedAt)} · ${g.turns?.length||0} turns · EV regret ${totalRegret.toFixed(1)}</div></div><span class="badge">${g.status.toUpperCase()}</span></div>`;
}

async function renderHistory(){
  const games=(await getGames()).filter(g=>g.turns?.length);
  const host=els['history-list'];host.innerHTML='';
  if(!games.length){host.innerHTML='<div class="panel"><p>No games recorded yet.</p></div>';return;}
  for(const g of games){
    const item=document.createElement('article');item.className='history-item';item.innerHTML=gameSummaryHtml(g);
    const turns=document.createElement('div');turns.className='turn-list';
    for(const t of g.turns){
      const div=document.createElement('div');div.className='turn';
      div.innerHTML=`<strong>Turn ${t.turn}</strong> · ${formatCards(t.before.hand)} → ${actionLabel(t.chosen)} · draws ${t.draws?.length?formatCards(t.draws):'—'} · regret ${(Number(t.regret)||0).toFixed(1)}`;turns.appendChild(div);
    }
    const del=document.createElement('button');del.className='secondary';del.textContent='Delete game';del.addEventListener('click',async()=>{if(confirm('Delete this saved game?')){await deleteGame(g.id);renderHistory();renderStats();}});
    item.appendChild(turns);item.appendChild(del);host.appendChild(item);
  }
}

async function renderStats(){
  const games=(await getGames()).filter(g=>g.status==='completed');
  const host=els['stats-grid'];host.innerHTML='';
  const scores=games.map(g=>g.score);
  const regrets=games.flatMap(g=>(g.turns||[]).map(t=>Number(t.regret)||0));
  const cards=[
    ['Games',games.length],['Average score',games.length?avg(scores).toFixed(1):'—'],['Best score',games.length?Math.max(...scores):'—'],['400+ rate',games.length?`${(scores.filter(s=>s>=400).length/games.length*100).toFixed(0)}%`:'—'],['Avg decision regret',regrets.length?avg(regrets).toFixed(1):'—'],['Zero-regret decisions',regrets.length?`${(regrets.filter(r=>r<0.5).length/regrets.length*100).toFixed(0)}%`:'—']
  ];
  for(const [label,value] of cards){const div=document.createElement('div');div.className='metric';div.innerHTML=`<span>${label}</span><strong>${value}</strong>`;host.appendChild(div);}
}

async function exportJson(){
  const games=await getGames();const blob=new Blob([JSON.stringify(games,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`okey-games-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function importJson(file){
  const data=JSON.parse(await file.text());await importGames(data);await renderHistory();await renderStats();alert('Games imported successfully.');
}

els['undo-btn'].addEventListener('click',undo);
els['new-game-btn'].addEventListener('click',newGame);
els['end-game-btn'].addEventListener('click',endGame);
els['precision-select'].addEventListener('change',()=>{clearRanking('Updating recommendation…');render();});
els['safe-mode-toggle'].addEventListener('change',()=>{safeDiscardMode=els['safe-mode-toggle'].checked;saveSafeMode();});
els['discard-cancel-btn'].addEventListener('click',()=>{pendingDiscardRow=null;els['discard-dialog'].close();});
els['discard-confirm-btn'].addEventListener('click',async()=>{
  const selected=pendingDiscardRow;pendingDiscardRow=null;els['discard-dialog'].close();if(selected)await applyMove(selected);
});
els['discard-dialog'].addEventListener('cancel',()=>{pendingDiscardRow=null;});
els['export-json-btn'].addEventListener('click',exportJson);
els['import-json-input'].addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{await importJson(file);}catch(err){alert(`Import failed: ${err.message}`);}finally{e.target.value='';}});
window.addEventListener('online',()=>{void flushTelemetryQueue();});

async function boot(){
  safeDiscardMode=loadSafeMode();
  els['safe-mode-toggle'].checked=safeDiscardMode;
  initWorker();
  game=await getLatestActiveGame()||createGame();
  await persist();
  render();
  await renderStats();
  void flushTelemetryQueue();
}
boot();
