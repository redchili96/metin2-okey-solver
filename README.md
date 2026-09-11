# Metin2 Okey Solver

A browser-based decision assistant for the Metin2 Okey Card Game.

## Goal

The solver is designed to maximize **expected final score**, not merely the probability of reaching 300 or 400 points. At each turn it compares every legal scoring play and discard against simulated future draws from the remaining unseen cards.

## v0.1 features

- Enter the 5 cards currently visible in Metin2
- Track all used and unseen cards automatically
- Rank legal plays and discards by expected remaining score
- Fast / Strong / Maximum simulation settings
- Apply the recommended move or deliberately choose an alternative
- Record every turn, recommendation, chosen action, draws and score
- Calculate expected-value regret for decisions that differ from the recommendation
- Save games locally with IndexedDB
- Game History and basic performance statistics
- Export and import the complete game dataset as JSON
- Solver runs in a Web Worker so the interface remains responsive

## Rules implemented

The app models the 24 unique Okey cards: values 1–8 in Blue, Red and Yellow.

Valid 3-card combinations are:

- Three identical numbers in different colours
- Three consecutive values in any colours
- Same-colour consecutive runs receive the higher official score

The game can continue until all 24 cards have been used.

## Important solver note

v0.1 uses Monte Carlo future simulation plus a rollout heuristic. The reported EV is therefore an estimate, especially early in the game. Future versions will add exact dynamic-programming / expectimax solving for tractable endgame states and improve calibration using the real-game dataset collected by the app.

## Run locally

Because the app uses JavaScript modules and a Web Worker, serve the repository through a local HTTP server rather than opening `index.html` directly.

For example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Hosting

The project is designed to be hosted as a static site using GitHub Pages.
