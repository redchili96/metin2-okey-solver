import { COLORS, CARD_BY_ID, unseenCards, actionLabel, cardLabel, createGame, scoreCombination } from './game.js';
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
let playSelection = [];

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
function isInitialSetup(){
  return game.turns.length===0 && game.used.length===0 && game.pendingDraws===0 && game.hand.length<5;
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
      renderPlayArea();
      renderRecommendation();
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
      if(playSelection.includes(id))button.classList.add('queued');
      if(game.used.includes(id)){button.classList.add('used');button.disabled=true;}
      button.addEventListener('click',()=>selectPoolCard(id));
      row.appendChild(button);
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
    if(!id){
      const slot=document.createElement('div');slot.className='slot empty';slot.textContent='Empty';host.appendChild(slot);continue;
    }
    if(playSelection.includes(id)){
      const slot=document.createElement('div');slot.className='slot moved';slot.title=`${cardLabel(id)} is in the play area`;host.appendChild(slot);continue;
    }
    const card=CARD_BY_ID[id],slot=document.createElement('div');slot.className='slot';
    const button=document.createElement('button');button.type='button';button.className=`card ${card.css}`;button.textContent=String(card.value);button.setAttribute('aria-label',cardLabel(id));
    if(recommendedCards.has(id)){
      button.classList.add('recommended-move');
      button.dataset.move=best.action.type==='discard'?'DISCARD':'PLAY';
    }
    if(isInitialSetup()){
      button.title=`${cardLabel(id)} — click to remove from setup`;
    }else{
      button.title=`${cardLabel(id)} — left-click to play · right-click to discard`;
    }
    button.addEventListener('click',()=>{void handleHandLeftClick(id);});
    button.addEventListener('contextmenu',event=>{event.preventDefault();void requestDiscard(id);});
    slot.appendChild(button);host.appendChild(slot);
  }
}

function renderPlayArea(){
  const host=els['play-slots'];host.innerHTML='';
  const best=latestRanking[0];
  const recommendedCards=new Set(best?.action?.type==='play' ? best.action.cards : []);
  for(let i=0;i<3;i++){
    const id=playSelection[i];
    const slot=document.createElement('div');slot.className='play-slot';
    if(!id){slot.textContent='Empty';host.appendChild(slot);continue;}
    const card=CARD_BY_ID[id];
    const button=document.createElement('button');button.type='button';button.className=`card ${card.css} play-selected`;button.textContent=String(card.value);button.setAttribute('aria-label',cardLabel(id));
    if(recommendedCards.has(id)){
      button.classList.add('recommended-move');
      button.dataset.move='PLAY';
    }
    button.title=`${cardLabel(id)} — click or right-click to return to your hand`;
    button.addEventListener('click',()=>returnFromPlayArea(id));
    button.addEventListener('contextmenu',event=>{event.preventDefault();returnFromPlayArea(id);});
    slot.appendChild(button);host.appendChild(slot);
  }

  els['play-count'].textContent=String(playSelection.length);
  const playButton=els['play-combination-btn'];
  const status=els['play-area-status'];
  playButton.hidden=true;playButton.disabled=true;status.className='play-area-status';

  if(playSelection.length===0){
    status.textContent='Left-click cards in your hand to move them here.';
    return;
  }
  if(playSelection.length<3){
    const remaining=3-playSelection.length;
    status.textContent=`Select ${remaining} more card${remaining===1?'':'s'} to build a combination.`;
    return;
  }

  const score=scoreCombination(playSelection);
  if(score<=0){
    status.textContent='These 3 cards do not form a valid Okey combination.';
    status.classList.add('invalid');
    return;
  }

  status.textContent=`Valid combination · +${score} points`;
  status.classList.add('valid');
  playButton.hidden=false;
  playButton.disabled=!latestRanking.length;
  playButton.textContent=latestRanking.length?`Play combination · +${score}`:'Waiting for calculation…';
}

function renderSummary(){
  const unseenCount=currentUnseenCount();
  const best=latestRanking[0];
  els['score-value'].textContent=String(game.score);
  els['unseen-count'].textContent=String(unseenCount);
  els['end-game-btn'].disabled=game.turns.length===0;

  if(game.pendingDraws>0){
    els['table-hint'].textContent=`Add ${game.pendingDraws} newly drawn card${game.pendingDraws===1?'':'s'} from the card pool below.`;
  }else if(game.hand.length===0 && unseenCount===0){
    els['table-hint'].textContent='All cards used. End & save the game.';
  }else if(isInitialSetup()){
    els['table-hint'].textContent=`Setup · select ${5-game.hand.length} more card${5-game.hand.length===1?'':'s'} from the pool below.`;
  }else if(playSelection.length>0){
    els['table-hint'].textContent='Build the combination in the play area, or return a card to your hand.';
  }else if(best?.action?.type==='discard'){
    els['table-hint'].textContent='Right-click the card you actually discarded in Metin2.';
  }else if(best?.action?.type==='play'){
    els['table-hint'].textContent='Left-click cards to move them into the play area.';
  }else if(game.hand.length<5 && unseenCount===0){
    els['table-hint'].textContent=`Final hand · ${game.hand.length} card${game.hand.length===1?'':'s'} left.`;
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

function renderRecommendation(){
  const best=latestRanking[0];
  const host=els['solver-results'];host.innerHTML='';
  if(!best)return;
  const wrapper=document.createElement('div');
  wrapper.innerHTML=`<div class="recommendation-action">${actionLabel(best.action)}</div><div class="recommendation-meta"><span>Projected final · ${(game.score+best.mean).toFixed(1)}</span><span>EV Search</span></div>`;
  host.appendChild(wrapper);
}

function render(){
  renderSummary();
  renderHand();
  renderPlayArea();
  renderCards();
  renderRecommendation();
  scheduleAutoAnalysis();
}

async function selectPoolCard(id){
  if(game.used.includes(id))return;

  if(game.hand.includes(id)){
    if(isInitialSetup()){
      snapshot();
      game.hand=game.hand.filter(cardId=>cardId!==id);
      playSelection=[];
      clearRanking('Adjust the starting hand.');
      await persist();render();
    }else{
      els['solver-status'].textContent='That card is already in your hand.';
    }
    return;
  }

  const canAddSetup=game.turns.length===0 && game.used.length===0 && game.pendingDraws===0 && game.hand.length<5;
  const canAddDraw=game.pendingDraws>0;
  if(!canAddSetup && !canAddDraw){
    els['solver-status'].textContent='The hand is complete. Use the cards above to record your move.';
    return;
  }
  if(game.hand.length>=5)return;

  snapshot();
  game.hand.push(id);
  if(game.pendingDraws>0){
    game.pendingDraws--;
    const last=game.turns.at(-1);
    if(last)last.draws.push(id);
  }
  playSelection=[];
  clearRanking(canAnalyzeCurrentState()?'Preparing recommendation…':'Add the remaining cards.');
  await persist();render();
}

async function handleHandLeftClick(id){
  if(isInitialSetup()){
    snapshot();
    game.hand=game.hand.filter(cardId=>cardId!==id);
    playSelection=[];
    clearRanking('Adjust the starting hand.');
    await persist();render();
    return;
  }
  requestMoveToPlayArea(id);
}

function requestMoveToPlayArea(id){
  if(!game.hand.includes(id))return;
  if(isInitialSetup()){
    els['solver-status'].textContent='Complete the starting hand first.';
    return;
  }
  if(game.pendingDraws>0){
    els['solver-status'].textContent='Add the replacement card before recording another move.';
    return;
  }
  if(playSelection.includes(id)){
    returnFromPlayArea(id);return;
  }
  if(playSelection.length>=3){
    els['play-area-status'].textContent='The play area can hold a maximum of 3 cards.';
    els['play-area-status'].className='play-area-status invalid';
    return;
  }
  playSelection.push(id);
  renderSummary();renderHand();renderPlayArea();renderCards();
}

function returnFromPlayArea(id){
  playSelection=playSelection.filter(cardId=>cardId!==id);
  renderSummary();renderHand();renderPlayArea();renderCards();
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
    await applyMove(row);return;
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

async function playSelectedCombination(){
  if(playSelection.length!==3)return;
  const score=scoreCombination(playSelection);
  if(score<=0)return;
  if(!latestRanking.length){
    els['solver-status'].textContent='Recommendation is still calculating…';
    return;
  }
  const selectedAction={type:'play',cards:[...playSelection],score};
  const row=latestRanking.find(item=>sameAction(item.action,selectedAction));
  if(!row){
    els['play-area-status'].textContent='This combination is not available in the current state.';
    els['play-area-status'].className='play-area-status invalid';
    return;
  }
  await applyMove(row);
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
  playSelection=[];
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
  game=createGame();historyStack=[];playSelection=[];clearRanking('Enter 5 cards to begin.');await persist();render();
}

async function endGame(){
  if(!confirm(`Finish this game with ${game.score} points?`))return;
  snapshot();game.status='completed';game.endedAt=new Date().toISOString();await persist();
  await archiveForTelemetry(clone(game));
  await renderHistory();await renderStats();setView('history');
  game=createGame();historyStack=[];playSelection=[];await persist();render();clearRanking('Enter 5 cards to begin.');
}

async function undo(){
  const previous=historyStack.pop();if(!previous){els['solver-status'].textContent='Nothing to undo.';return;}
  game=previous;playSelection=[];clearRanking('Previous state restored.');await persist();render();
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
els['play-combination-btn'].addEventListener('click',()=>{void playSelectedCombination();});
els['precision-select'].addEventListener('change',()=>{playSelection=[];clearRanking('Updating recommendation…');render();});
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
  playSelection=[];
  await persist();
  render();
  await renderStats();
  void flushTelemetryQueue();
}
boot();
