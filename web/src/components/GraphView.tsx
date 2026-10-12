import dagre from 'dagre';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useMemo } from 'react';
import type { CausalEdge, GraphNode, Investigation } from '../api.ts';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | null;

const NODE_W = 210;
const NODE_H = 58;
const CLASS_RANK = { proven: 3, derived: 2, inferred: 1, weak: 0 } as const;

export const fmtMs = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1) return '<1 ms';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
};

interface NodeData extends Record<string, unknown> {
  node: GraphNode;
  rank: number | null;
  frontier: boolean;
  isFailure: boolean;
  inSubgraph: boolean;
  reveal: boolean;
  selected: boolean;
}

const EventNode = memo(function EventNode({ data }: NodeProps<Node<NodeData>>) {
  const n = data.node;
  const svc = (n.service ?? '').replace('-service', '');
  const bad = n.status === 'ERROR' || n.status === 'TIMEOUT';
  return (
    <div
      className={`gnode svc-${svc} ${data.inSubgraph ? '' : 'faded'} ${data.selected ? 'selected' : ''} ${data.isFailure ? 'failure' : ''} ${data.rank === 1 ? 'top' : ''}`}
      role="button"
      aria-label={`${n.service} ${n.operation}, ${fmtMs(n.duration_ms)}, ${n.status}${data.rank ? `, ranked ${data.rank}` : ''}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="gnode-badges">
        {data.rank !== null && <span className="badge rank">#{data.rank}</span>}
        {data.frontier && <span className="badge frontier">ORIGIN</span>}
        {data.isFailure && <span className="badge fail">FAILURE</span>}
        {data.reveal && n.is_fault_injected && <span className="badge fault">⚗ INJECTED</span>}
      </div>
      <div className="gnode-op">{n.operation}{(n.attempt_number ?? 1) > 1 ? <span className="attempt"> · attempt {n.attempt_number}</span> : null}</div>
      <div className="gnode-sub">
        <span className="svc-tag">{svc}</span>
        <span>{fmtMs(n.duration_ms)}</span>
        <span className={bad ? 'st bad' : 'st'}>{n.status}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

const nodeTypes = { event: EventNode };

interface Merged {
  from: string;
  to: string;
  edges: CausalEdge[];
  cls: keyof typeof CLASS_RANK;
}

function mergeEdges(edges: CausalEdge[]): Merged[] {
  const by = new Map<string, Merged>();
  for (const e of edges) {
    const k = `${e.from_event_id}>${e.to_event_id}`;
    const m = by.get(k) ?? { from: e.from_event_id, to: e.to_event_id, edges: [], cls: 'weak' as const };
    m.edges.push(e);
    if (CLASS_RANK[e.evidence_class] > CLASS_RANK[m.cls] || m.edges.length === 1) m.cls = e.evidence_class;
    by.set(k, m);
  }
  return [...by.values()];
}

const DASH: Record<string, string | undefined> = { proven: undefined, derived: '7 5', inferred: '2 5', weak: '1 8' };

export function GraphView(props: {
  nodes: GraphNode[];
  edges: CausalEdge[];
  investigation: Investigation | undefined;
  focusPath: Set<string>; // "from>to" pairs along the selected candidate's path
  selection: Selection;
  reveal: boolean;
  onSelect: (s: Selection) => void;
}) {
  const { nodes, edges, investigation, focusPath, selection, reveal, onSelect } = props;

  const { rfNodes, rfEdges } = useMemo(() => {
    const merged = mergeEdges(edges);
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 34, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    const ids = new Set(nodes.map((n) => n.event_id));
    for (const n of nodes) g.setNode(n.event_id, { width: NODE_W, height: NODE_H });
    for (const m of merged) if (ids.has(m.from) && ids.has(m.to) && m.cls !== 'weak') g.setEdge(m.from, m.to);
    dagre.layout(g);

    const sub = new Set(investigation?.subgraph_event_ids ?? nodes.map((n) => n.event_id));
    const rankOf = new Map(investigation?.candidates.map((c) => [c.event_id, c]) ?? []);
    const rfNodes: Node<NodeData>[] = nodes.map((n) => {
      const p = g.node(n.event_id);
      const c = rankOf.get(n.event_id);
      return {
        id: n.event_id,
        type: 'event',
        position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 },
        data: {
          node: n, rank: c?.rank ?? null, frontier: !!c?.in_frontier, isFailure: n.event_id === investigation?.failure_event_id,
          inSubgraph: sub.has(n.event_id), reveal, selected: selection?.kind === 'node' && selection.id === n.event_id,
        },
        draggable: false,
      };
    });

    const anyFocus = focusPath.size > 0;
    const rfEdges: Edge[] = merged.filter((m) => ids.has(m.from) && ids.has(m.to)).map((m) => {
      const key = `${m.from}>${m.to}`;
      const onPath = focusPath.has(key);
      const sel = selection?.kind === 'edge' && selection.from === m.from && selection.to === m.to;
      const dim = anyFocus && !onPath;
      const types = [...new Set(m.edges.map((e) => e.type))];
      const best = m.edges.reduce((a, b) => (CLASS_RANK[b.evidence_class] > CLASS_RANK[a.evidence_class] ? b : a));
      const suffix = m.cls === 'proven' ? '' : ` · ${m.cls}${m.cls === 'inferred' ? ` ${best.confidence.toFixed(2)}` : ''}`;
      return {
        id: key,
        source: m.from,
        target: m.to,
        label: `${types.map((t) => t.replace(/_/g, ' ').toLowerCase()).join(' + ')}${suffix}`,
        labelStyle: { fontSize: 10, fill: 'var(--text)' },
        labelBgStyle: { fill: 'var(--panel)', fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number],
        style: { stroke: sel || onPath ? 'var(--accent)' : 'var(--edge)', strokeWidth: sel || onPath ? 3 : m.cls === 'proven' ? 2 : 1.6, strokeDasharray: DASH[m.cls], opacity: dim ? 0.25 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: sel || onPath ? 'var(--accent)' : 'var(--edge)' },
        interactionWidth: 18,
      } satisfies Edge;
    });
    return { rfNodes, rfEdges };
  }, [nodes, edges, investigation, focusPath, selection, reveal]);

  if (nodes.length === 0) return <div className="empty">No events for this operation under the chosen rule set.</div>;

  return (
    <div className="graph" data-testid="graph">
      <ReactFlow
        key={`${nodes.length}:${edges.length}:${investigation?.rule_set_id ?? ''}`}
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={1.6}
        onNodeClick={(_, n) => onSelect({ kind: 'node', id: n.id })}
        onEdgeClick={(_, e) => onSelect({ kind: 'edge', from: e.source, to: e.target })}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color="var(--grid)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="legend" aria-label="Edge legend">
        <span><i className="line solid" /> proven — a field in the telemetry states it</span>
        <span><i className="line dashed" /> derived — deterministic rule over proven facts</span>
        <span><i className="line dotted" /> inferred — heuristic, capped at 0.75</span>
      </div>
    </div>
  );
}
