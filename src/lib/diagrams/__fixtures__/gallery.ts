// src/lib/diagrams/__fixtures__/gallery.ts — Playwright snapshot fixtures
// for the four Sprint F.2 SVG primitives.
//
// What this is:
// -------------
// A frozen catalog of payloads consumed by:
//   1. tests/playwright/diagrams.spec.ts — drives `page.goto` + screenshot
//      assertions.
//   2. src/app/diagram-gallery/[kind]/page.tsx — dev-only route that
//      renders a single fixture by URL param.
//
// Three fixtures per primitive (per RFC §"Where snapshots live"):
//   - `minimal`   — smallest schema-valid payload.
//   - `max-size`  — largest schema-valid payload exercising the upper
//                   bounds of the per-primitive caps.
//   - `edge-case` — payload that exercises a primitive-specific feature
//                   not covered by the other two (self-loop / bidir pair /
//                   self-message / lopsided tree, etc.).
//
// Location note:
// --------------
// These fixtures normally live under `tests/playwright/fixtures/diagrams.ts`
// per the RFC, but `tests/` is outside `tsconfig.include` so a Next.js
// page can't import from there without typecheck errors. Living under
// `src/lib/diagrams/__fixtures__/` lets the dev-only gallery page import
// via the `@/` alias cleanly; the Playwright spec re-imports via a
// relative path (Playwright runs outside Next.js's typecheck pass).

import type {
  DecisionTreePayload,
  DiagramFlowPayload,
  SequenceDiagramPayload,
  StateTransitionDiagramPayload,
} from '@/lib/diagrams/schema';

// ---------------------------------------------------------------------------
// DiagramFlow
// ---------------------------------------------------------------------------

const diagramFlowMinimal: DiagramFlowPayload = {
  kind: 'DiagramFlow',
  direction: 'LR',
  nodes: [
    { id: 'a', label: 'Start' },
    { id: 'b', label: 'End' },
  ],
  edges: [{ from: 'a', to: 'b' }],
};

const diagramFlowMaxSize: DiagramFlowPayload = {
  kind: 'DiagramFlow',
  title: 'Maximum pipeline',
  direction: 'LR',
  nodes: [
    { id: 'n1', label: 'Ingest', kind: 'start' },
    { id: 'n2', label: 'Parse' },
    { id: 'n3', label: 'Classify' },
    { id: 'n4', label: 'Branch?', kind: 'decision' },
    { id: 'n5', label: 'Chunk' },
    { id: 'n6', label: 'Embed' },
    { id: 'n7', label: 'Store', kind: 'end' },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n4' },
    { from: 'n4', to: 'n5', label: 'yes' },
    { from: 'n4', to: 'n6', label: 'no' },
    { from: 'n5', to: 'n7' },
    { from: 'n6', to: 'n7' },
  ],
};

const diagramFlowEdgeCase: DiagramFlowPayload = {
  kind: 'DiagramFlow',
  title: 'Top-to-bottom with all node kinds',
  direction: 'TB',
  nodes: [
    { id: 's', label: 'Begin', kind: 'start' },
    { id: 'p', label: 'Work', kind: 'process' },
    { id: 'd', label: 'Check?', kind: 'decision' },
    { id: 'e', label: 'Finish', kind: 'end' },
  ],
  edges: [
    { from: 's', to: 'p' },
    { from: 'p', to: 'd' },
    { from: 'd', to: 'e', label: 'ok' },
  ],
};

// ---------------------------------------------------------------------------
// StateTransitionDiagram
// ---------------------------------------------------------------------------

const stateMinimal: StateTransitionDiagramPayload = {
  kind: 'StateTransitionDiagram',
  states: [
    { id: 's0', label: 'Idle', initial: true },
    { id: 's1', label: 'Done', terminal: true },
  ],
  transitions: [{ from: 's0', to: 's1', trigger: 'go' }],
};

const stateMaxSize: StateTransitionDiagramPayload = {
  kind: 'StateTransitionDiagram',
  title: 'Eight-state cycle',
  states: [
    { id: 's1', label: 'Init', initial: true },
    { id: 's2', label: 'Loading' },
    { id: 's3', label: 'Ready' },
    { id: 's4', label: 'Running' },
    { id: 's5', label: 'Paused' },
    { id: 's6', label: 'Stopping' },
    { id: 's7', label: 'Cleanup' },
    { id: 's8', label: 'Done', terminal: true },
  ],
  transitions: [
    { from: 's1', to: 's2', trigger: 'boot' },
    { from: 's2', to: 's3', trigger: 'loaded' },
    { from: 's3', to: 's4', trigger: 'start' },
    { from: 's4', to: 's5', trigger: 'pause' },
    { from: 's5', to: 's4', trigger: 'resume' },
    { from: 's4', to: 's6', trigger: 'stop' },
    { from: 's6', to: 's7', trigger: 'flushed' },
    { from: 's7', to: 's8', trigger: 'done' },
  ],
};

const stateEdgeCase: StateTransitionDiagramPayload = {
  kind: 'StateTransitionDiagram',
  title: 'Self-loop + bidirectional pair',
  states: [
    { id: 'a', label: 'Active', initial: true },
    { id: 'b', label: 'Waiting' },
    { id: 'c', label: 'Done', terminal: true },
  ],
  transitions: [
    { from: 'a', to: 'a', trigger: 'tick' }, // self-loop
    { from: 'a', to: 'b', trigger: 'wait' },
    { from: 'b', to: 'a', trigger: 'wake' }, // bidirectional pair with a→b
    { from: 'b', to: 'c', trigger: 'finish' },
  ],
};

// ---------------------------------------------------------------------------
// SequenceDiagram
// ---------------------------------------------------------------------------

const sequenceMinimal: SequenceDiagramPayload = {
  kind: 'SequenceDiagram',
  actors: ['Client', 'Server'],
  messages: [{ from: 'Client', to: 'Server', label: 'GET /' }],
};

const sequenceMaxSize: SequenceDiagramPayload = {
  kind: 'SequenceDiagram',
  title: 'Maximum lane count',
  actors: ['Client', 'Edge', 'API', 'Auth', 'DB', 'Worker'],
  messages: [
    { from: 'Client', to: 'Edge', label: 'request' },
    { from: 'Edge', to: 'Auth', label: 'verify' },
    { from: 'Auth', to: 'Edge', label: 'ok', kind: 'return' },
    { from: 'Edge', to: 'API', label: 'forward' },
    { from: 'API', to: 'DB', label: 'query' },
    { from: 'DB', to: 'API', label: 'rows', kind: 'return' },
    { from: 'API', to: 'Worker', label: 'enqueue', kind: 'async' },
    { from: 'API', to: 'Edge', label: 'response', kind: 'return' },
    { from: 'Edge', to: 'Client', label: '200 OK', kind: 'return' },
  ],
};

const sequenceEdgeCase: SequenceDiagramPayload = {
  kind: 'SequenceDiagram',
  title: 'Self-message',
  actors: ['Service', 'Cache'],
  messages: [
    { from: 'Service', to: 'Cache', label: 'lookup' },
    { from: 'Cache', to: 'Service', label: 'miss', kind: 'return' },
    { from: 'Service', to: 'Service', label: 'compute' }, // self-message
    { from: 'Service', to: 'Cache', label: 'store' },
  ],
};

// ---------------------------------------------------------------------------
// DecisionTree
// ---------------------------------------------------------------------------

const treeMinimal: DecisionTreePayload = {
  kind: 'DecisionTree',
  root: {
    question: 'Is it raining?',
    yes: { leaf: 'Bring umbrella' },
    no: { leaf: 'Wear sunglasses' },
  },
};

const treeMaxSize: DecisionTreePayload = {
  kind: 'DecisionTree',
  title: 'Balanced 4-level tree',
  root: {
    question: 'Is request authenticated?',
    yes: {
      question: 'Is user an admin?',
      yes: {
        question: 'Is target sensitive?',
        yes: { leaf: 'Audit log + allow' },
        no: { leaf: 'Allow' },
      },
      no: {
        question: 'Owns resource?',
        yes: { leaf: 'Allow' },
        no: { leaf: 'Forbidden' },
      },
    },
    no: {
      question: 'Endpoint public?',
      yes: { leaf: 'Allow' },
      no: { leaf: 'Unauthorized' },
    },
  },
};

const treeEdgeCase: DecisionTreePayload = {
  kind: 'DecisionTree',
  title: 'Lopsided right-heavy tree',
  root: {
    question: 'Quick exit?',
    yes: { leaf: 'Done' },
    no: {
      question: 'Step 2?',
      yes: { leaf: 'Done at 2' },
      no: {
        question: 'Step 3?',
        yes: { leaf: 'Done at 3' },
        no: {
          question: 'Step 4?',
          yes: { leaf: 'Done at 4' },
          no: { leaf: 'Fall through' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Public catalog
// ---------------------------------------------------------------------------

export type GalleryKind =
  | 'DiagramFlow'
  | 'StateTransitionDiagram'
  | 'SequenceDiagram'
  | 'DecisionTree';

export type GalleryFixtureName = 'minimal' | 'max-size' | 'edge-case';

export const galleryFixtures = {
  DiagramFlow: {
    minimal: diagramFlowMinimal,
    'max-size': diagramFlowMaxSize,
    'edge-case': diagramFlowEdgeCase,
  },
  StateTransitionDiagram: {
    minimal: stateMinimal,
    'max-size': stateMaxSize,
    'edge-case': stateEdgeCase,
  },
  SequenceDiagram: {
    minimal: sequenceMinimal,
    'max-size': sequenceMaxSize,
    'edge-case': sequenceEdgeCase,
  },
  DecisionTree: {
    minimal: treeMinimal,
    'max-size': treeMaxSize,
    'edge-case': treeEdgeCase,
  },
} as const;
