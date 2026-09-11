export const COLORS = [
  { code: 'B', label: 'Blue', css: 'blue' },
  { code: 'R', label: 'Red', css: 'red' },
  { code: 'Y', label: 'Yellow', css: 'yellow' },
];

export const CARDS = COLORS.flatMap((color, colorIndex) =>
  Array.from({ length: 8 }, (_, i) => ({
    id: `${color.code}${i + 1}`,
    color: color.code,
    colorLabel: color.label,
    css: color.css,
    value: i + 1,
    index: colorIndex * 8 + i,
  }))
);

export const CARD_BY_ID = Object.fromEntries(CARDS.map(card => [card.id, card]));

export function cardLabel(id) {
  const card = CARD_BY_ID[id];
  return card ? `${card.value} (${card.colorLabel})` : String(id ?? '');
}

export function scoreCombination(ids) {
  if (!Array.isArray(ids) || ids.length !== 3) return 0;
  const cards = ids.map(id => CARD_BY_ID[id]).filter(Boolean);
  if (cards.length !== 3) return 0;
  const values = cards.map(card => card.value).sort((a, b) => a - b);
  const colors = new Set(cards.map(card => card.color));

  if (values[0] === values[1] && values[1] === values[2] && colors.size === 3) {
    return (values[0] + 1) * 10;
  }

  const consecutive = values[0] + 1 === values[1] && values[1] + 1 === values[2];
  if (!consecutive) return 0;
  return values[0] * 10 + (colors.size === 1 ? 40 : 0);
}

export function legalActions(hand) {
  const actions = hand.map(id => ({ type: 'discard', cards: [id], score: 0 }));
  for (let a = 0; a < hand.length - 2; a++) {
    for (let b = a + 1; b < hand.length - 1; b++) {
      for (let c = b + 1; c < hand.length; c++) {
        const cards = [hand[a], hand[b], hand[c]];
        const score = scoreCombination(cards);
        if (score > 0) actions.push({ type: 'play', cards, score });
      }
    }
  }
  return actions;
}

export function unseenCards(hand, used) {
  const blocked = new Set([...hand, ...used]);
  return CARDS.filter(card => !blocked.has(card.id)).map(card => card.id);
}

export function actionLabel(action) {
  if (!action) return '—';
  const cards = (action.cards || []).map(cardLabel);
  if (action.type === 'play') return `Play ${cards.join(' + ')} — ${action.score} pts`;
  return `Discard ${cards[0] || '—'}`;
}

export function createGame() {
  return {
    id: globalThis.crypto?.randomUUID?.() || `game-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    version: 1,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'active',
    score: 0,
    hand: [],
    used: [],
    pendingDraws: 0,
    turns: [],
  };
}
