const COLORS = ['B','R','Y'];
const CARDS = COLORS.flatMap((color, colorIndex) => Array.from({length:8},(_,i)=>({id:`${color}${i+1}`,color,value:i+1,index:colorIndex*8+i})));
const BY_ID = Object.fromEntries(CARDS.map(c=>[c.id,c]));

function scoreCombo(ids){
  if(ids.length!==3)return 0;
  const c=ids.map(id=>BY_ID[id]);
  const v=c.map(x=>x.value).sort((a,b)=>a-b);
  const colors=new Set(c.map(x=>x.color));
  if(v[0]===v[1]&&v[1]===v[2]&&colors.size===3)return (v[0]+1)*10;
  if(v[0]+1===v[1]&&v[1]+1===v[2])return v[0]*10+(colors.size===1?40:0);
  return 0;
}

function combos(hand){
  const out=[];
  for(let a=0;a<hand.length-2;a++)for(let b=a+1;b<hand.length-1;b++)for(let c=b+1;c<hand.length;c++){
    const cards=[hand[a],hand[b],hand[c]],score=scoreCombo(cards);
    if(score>0)out.push({type:'play',cards,score});
  }
  return out;
}
function actions(hand){return [...hand.map(id=>({type:'discard',cards:[id],score:0})),...combos(hand)];}
function unseen(hand,used){const s=new Set([...hand,...used]);return CARDS.map(c=>c.id).filter(id=>!s.has(id));}
function randomDraw(deck,count){
  const copy=deck.slice(),out=[];
  for(let i=0;i<count&&copy.length;i++){const j=Math.floor(Math.random()*copy.length);out.push(copy[j]);copy.splice(j,1)}
  return {drawn:out,remaining:copy};
}

function allLiveCombos(hand,deck){
  const available=[...hand,...deck],set=new Set(available),list=[];
  for(let n=1;n<=8;n++){
    const ids=COLORS.map(c=>`${c}${n}`);if(ids.every(id=>set.has(id)))list.push({cards:ids,score:(n+1)*10});
  }
  for(let start=1;start<=6;start++){
    for(const c1 of COLORS)for(const c2 of COLORS)for(const c3 of COLORS){
      const ids=[`${c1}${start}`,`${c2}${start+1}`,`${c3}${start+2}`];
      if(ids.every(id=>set.has(id)))list.push({cards:ids,score:scoreCombo(ids)});
    }
  }
  return list;
}

function potential(hand,deck){
  const live=allLiveCombos(hand,deck);
  let value=0;
  for(const combo of live){
    const held=combo.cards.filter(id=>hand.includes(id)).length;
    if(held===3)value=Math.max(value,combo.score*1.2);
    else if(held===2)value+=combo.score*0.34;
    else if(held===1)value+=combo.score*0.025;
  }
  return value;
}

function rolloutPolicy(hand,deck){
  const acts=actions(hand);let best=acts[0],bestV=-Infinity;
  for(const a of acts){
    const kept=hand.filter(id=>!a.cards.includes(id));
    const v=a.score + potential(kept,deck)*0.22 + (a.type==='discard'?4:0);
    if(v>bestV){bestV=v;best=a;}
  }
  return best;
}

function applyAction(hand,deck,action){
  const kept=hand.filter(id=>!action.cards.includes(id));
  const need=Math.min(5-kept.length,deck.length);
  const draw=randomDraw(deck,need);
  return {hand:[...kept,...draw.drawn],deck:draw.remaining,gain:action.score};
}

function rollout(hand,deck){
  let total=0,guard=0;
  while((hand.length||deck.length)&&guard++<30){
    if(hand.length<5&&deck.length){const draw=randomDraw(deck,Math.min(5-hand.length,deck.length));hand=[...hand,...draw.drawn];deck=draw.remaining;}
    if(!hand.length)break;
    const a=rolloutPolicy(hand,deck);if(!a)break;
    const next=applyAction(hand,deck,a);total+=next.gain;hand=next.hand;deck=next.deck;
  }
  return total;
}

function estimate(state,action,trials){
  const deck0=unseen(state.hand,state.used);let sum=0,sum2=0;
  for(let t=0;t<trials;t++){
    const first=applyAction(state.hand,deck0,action);
    const gain=first.gain+rollout(first.hand,first.deck);
    sum+=gain;sum2+=gain*gain;
  }
  const mean=sum/trials;const variance=Math.max(0,sum2/trials-mean*mean);return {mean,se:Math.sqrt(variance/trials)};
}

self.onmessage=(event)=>{
  const {type,state,simulations=800}=event.data||{};
  if(type!=='analyze')return;
  try{
    const acts=actions(state.hand);
    const per=Math.max(60,Math.floor(simulations/Math.max(1,acts.length)));
    const ranked=acts.map(action=>({action,...estimate(state,action,per)})).sort((a,b)=>b.mean-a.mean);
    self.postMessage({type:'result',ranked,simulationsPerAction:per});
  }catch(error){self.postMessage({type:'error',message:error?.message||String(error)});}
};
