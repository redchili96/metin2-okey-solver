import { CARDS, COLORS, CARD_BY_ID, unseenCards, actionLabel, createGame } from './game.js';
import { saveGame, getGames, getLatestActiveGame, importGames, deleteGame } from './storage.js';

const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
let game = null;
let historyStack = [];
let latestRanking = [];
let worker = null;

function clone(value){ return structuredClone(value); }
function fmtDate(iso){ return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(iso)); }
function avg(values){ return values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0; }

function initWorker(){
  worker?.terminate();
  worker = new Worker('./js/solver-worker.js');
  worker.onmessage = event => {
    const msg = event.data;
    if(msg.type==='error'){
      els['solver-status'].textContent=`Solver error: ${msg.message}`;
      els['analyze-btn'].disabled=false;
      return;
    }
    if(msg.type==='result'){
      latestRanking=msg.ranked;
      renderRanking();
      els['solver-status'].textContent=`Compared ${msg.ranked.length} legal moves using ${msg.simulationsPerAction} simulated futures per move.`;
      els['analyze-btn'].disabled=false;
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
      button.type='button';button.className=`card ${color.css}`;button.textContent=String(v);button.setAttribute('aria-label',`${color.label} ${v}`);
      if(game.hand.includes(id))button.classList.add('selected');
      if(game.used.includes(id)){button.classList.add('used');button.disabled=true;}
      button.addEventListener('click',()=>toggleCard(id));row.appendChild(button);
    }
    grid.appendChild(row);
  }
}

function renderHand(){
  const host=els['hand-slots'];host.innerHTML='';
  for(let i=0;i<5;i++){
    const id=game.hand[i];
    if(!id){const slot=document.createElement('div');slot.className='slot empty';slot.textContent='Empty';host.appendChild(slot);continue;}
    const card=CARD_BY_ID[id],slot=document.createElement('div');slot.className='slot';
    const button=document.createElement('button');button.type='button';button.className=`card ${card.css}`;button.textContent=String(card.value);button.title='Click to correct/remove this card';button.addEventListener('click',()=>toggleCard(id));slot.appendChild(button);host.appendChild(slot);
  }
}

function renderSummary(){
  els['score-value'].textContent=String(game.score);
  els['hand-count'].textContent=`${game.hand.length} / 5`;
  els['unseen-count'].textContent=String(unseenCards(game.hand,game.used).length);
  els['used-count'].textContent=String(game.used.length);
  els['analyze-btn'].disabled=game.hand.length!==5;
  els['end-game-btn'].disabled=game.turns.length===0;
  if(game.pendingDraws>0)els['table-hint'].textContent=`Add ${game.pendingDraws} newly drawn card${game.pendingDraws===1?'':'s'}.`;
  else if(game.hand.length<5)els['table-hint'].textContent=`Select ${5-game.hand.length} more card${5-game.hand.length===1?'':'s'} from Metin2.`;
  else els['table-hint'].textContent='Table captured. Analyze the best move.';
}

function clearRanking(message='State changed — analyze again.'){
  latestRanking=[];els['solver-results'].innerHTML='';els['solver-status'].textContent=message;
}

function render(){ renderSummary();renderHand();renderCards(); }

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
    if(last) last.draws.push(id);
  }
  clearRanking(game.hand.length===5?'Ready to analyze.':'Add the remaining cards.');
  await persist();render();
}

function analyze(){
  if(game.hand.length!==5)return;
  els['analyze-btn'].disabled=true;els['solver-status'].textContent='Calculating expected final score…';els['solver-results'].innerHTML='';
  worker.postMessage({type:'analyze',state:{hand:game.hand,used:game.used,score:game.score},simulations:Number(els['precision-select'].value)});
}

function renderRanking(){
  const host=els['solver-results'];host.innerHTML='';
  latestRanking.slice(0,4).forEach((row,index)=>{
    const card=document.createElement('article');card.className=`result-card${index===0?' best':''}`;
    const ci=Math.max(1,1.96*row.se);
    card.innerHTML=`<div class="result-top"><div><div class="result-rank">${index===0?'RECOMMENDED':`OPTION ${index+1}`}</div><div class="result-title">${actionLabel(row.action)}</div></div><span class="badge">EV SEARCH</span></div><div class="result-metrics"><div><span>Expected remaining score</span><strong>${row.mean.toFixed(1)} ± ${ci.toFixed(1)}</strong></div><div><span>Projected final score</span><strong>${(game.score+row.mean).toFixed(1)}</strong></div><div><span>EV gap vs best</span><strong>${index===0?'0.0':(latestRanking[0].mean-row.mean).toFixed(1)}</strong></div></div>`;
    const button=document.createElement('button');button.type='button';button.className=index===0?'primary':'secondary';button.textContent=index===0?'Apply recommended move':'Apply this move';button.addEventListener('click',()=>applyMove(row));card.appendChild(button);host.appendChild(card);
  });
}

async function applyMove(selectedRow){
  snapshot();
  const before={score:game.score,hand:[...game.hand],used:[...game.used]};
  const best=latestRanking[0];
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
  };
  game.turns.push(turn);
  game.hand=game.hand.filter(id=>!selectedRow.action.cards.includes(id));
  game.used=[...game.used,...selectedRow.action.cards];
  game.score+=selectedRow.action.score;
  game.pendingDraws=Math.min(5-game.hand.length,unseenCards(game.hand,game.used).length);
  clearRanking(selectedRow.action.type==='play'?`+${selectedRow.action.score} points. Enter the replacement cards.`:'Card discarded. Enter the replacement card.');
  await persist();render();
}

async function newGame(){
  if(game?.turns?.length && !confirm('Start a new game? The current game will remain saved in History.'))return;
  if(game && game.status==='active' && game.turns.length){game.status='abandoned';game.endedAt=new Date().toISOString();await persist();}
  game=createGame();historyStack=[];clearRanking('Enter 5 cards to begin.');await persist();render();
}

async function endGame(){
  if(!confirm(`Finish this game with ${game.score} points?`))return;
  snapshot();game.status='completed';game.endedAt=new Date().toISOString();await persist();
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
      div.innerHTML=`<strong>Turn ${t.turn}</strong> · ${t.before.hand.join(' ')} → ${actionLabel(t.chosen)} · draws ${t.draws?.join(' ')||'—'} · regret ${(Number(t.regret)||0).toFixed(1)}`;turns.appendChild(div);
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

els['analyze-btn'].addEventListener('click',analyze);
els['undo-btn'].addEventListener('click',undo);
els['new-game-btn'].addEventListener('click',newGame);
els['end-game-btn'].addEventListener('click',endGame);
els['export-json-btn'].addEventListener('click',exportJson);
els['import-json-input'].addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{await importJson(file);}catch(err){alert(`Import failed: ${err.message}`);}finally{e.target.value='';}});

async function boot(){
  initWorker();
  game=await getLatestActiveGame()||createGame();
  await persist();
  render();
  await renderStats();
}
boot();
