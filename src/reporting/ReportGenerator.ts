import type { RunRecord, RunToolEvent } from './RunTracker.js';

interface ReportOptions {
  maxOutputChars?: number;
}

interface ToolSummary {
  id: string;
  name: string;
  count: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  durations: number[];
  samples: string[];
}

interface DashboardNode {
  id: string;
  name: string;
  type: 'terminal' | 'lead' | 'tool';
  color: string;
}

interface DashboardEdge {
  from: string;
  to: string;
  kind: 'tree' | 'comm';
  label?: string;
  count?: number;
}

interface DashboardData {
  session: {
    id: string;
    sessionName: string;
    runType: 'babysitter' | 'general';
    startedAt: number;
    endedAt: number;
    durationMs: number;
    workingDir?: string;
    chatId?: number;
    threadId?: number;
    userId?: number;
    inputCount: number;
    toolCount: number;
    eventCount: number;
    outputChars: number;
  };
  nodes: DashboardNode[];
  edges: DashboardEdge[];
  tools: ToolSummary[];
  events: Array<{ offsetMs: number; type: string; detail?: string }>;
  inputs: Array<{ timestamp: number; text: string; isFollowup: boolean }>;
  outputPreview: string;
  errors: string[];
}

const COLORS = ['#3fb950', '#58a6ff', '#bc8cff', '#06b6d4', '#f0883e', '#db61a2'];

export class ReportGenerator {
  static generateHtml(run: RunRecord, options: ReportOptions = {}): string {
    const maxOutputChars = options.maxOutputChars ?? 12000;
    const outputText = run.outputText.length > maxOutputChars
      ? run.outputText.slice(0, maxOutputChars - 3) + '...'
      : run.outputText;

    const startedAt = run.startedAt;
    const endedAt = run.endedAt ?? this.getLastEventTimestamp(run) ?? Date.now();
    const durationMs = Math.max(0, endedAt - startedAt);
    const toolSummaries = this.buildToolSummaries(run.toolEvents);

    const nodes: DashboardNode[] = [
      { id: 'start', name: 'START', type: 'terminal', color: '#58a6ff' },
      { id: 'lead', name: 'Lead', type: 'lead', color: '#d57455' },
      ...toolSummaries.map((tool, index) => ({
        id: tool.id,
        name: tool.name.length > 22 ? `${tool.name.slice(0, 20)}..` : tool.name,
        type: 'tool' as const,
        color: COLORS[index % COLORS.length],
      })),
      { id: 'end', name: 'END', type: 'terminal', color: '#58a6ff' },
    ];

    const edges: DashboardEdge[] = [
      { from: 'start', to: 'lead', kind: 'tree' },
      ...toolSummaries.map((tool) => ({ from: 'lead', to: tool.id, kind: 'tree' as const })),
      ...toolSummaries.map((tool) => ({ from: tool.id, to: 'end', kind: 'tree' as const })),
      ...toolSummaries.map((tool) => ({ from: 'lead', to: tool.id, kind: 'comm' as const, label: 'tool_call', count: tool.count })),
      ...toolSummaries.map((tool) => ({ from: tool.id, to: 'lead', kind: 'comm' as const, label: 'tool_result', count: tool.successCount + tool.failureCount })),
    ];

    const data: DashboardData = {
      session: {
        id: run.id,
        sessionName: run.context?.sessionName || run.sessionId,
        runType: run.runType,
        startedAt,
        endedAt,
        durationMs,
        workingDir: run.context?.workingDir,
        chatId: run.context?.chatId,
        threadId: run.context?.threadId,
        userId: run.context?.userId,
        inputCount: run.inputs.length,
        toolCount: run.toolEvents.length,
        eventCount: run.events.length,
        outputChars: run.outputText.length,
      },
      nodes,
      edges,
      tools: toolSummaries,
      events: run.events.map((event) => ({
        offsetMs: Math.max(0, event.timestamp - startedAt),
        type: event.type,
        detail: event.detail,
      })),
      inputs: run.inputs,
      outputPreview: outputText,
      errors: run.errors,
    };

    const serialized = this.escapeForScript(JSON.stringify(data));

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Run Dashboard ${this.escapeHtml(run.id)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-overlay: #21262d;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #484f58;
      --border: #30363d;
      --border-dim: #21262d;
      --accent: #d57455;
      --blue: #1f6feb;
      --sidebar-width: 280px;
      --panel-width: 360px;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      height: 100vh;
      overflow: hidden;
    }
    .app-container {
      display: flex;
      height: 100vh;
      width: 100vw;
    }
    .sidebar {
      width: var(--sidebar-width);
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .sidebar-header {
      padding: 0 18px;
      border-bottom: 1px solid var(--border);
      height: 56px;
      display: flex;
      align-items: center;
      font-weight: 700;
      font-size: 15px;
      color: var(--text-primary);
    }
    .sidebar-section-title {
      padding: 14px 18px 8px;
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-weight: 600;
    }
    .sidebar-nav {
      padding: 6px 10px;
      overflow: auto;
      flex: 1;
    }
    .session-card {
      width: 100%;
      border: 1px solid rgba(31, 111, 235, 0.5);
      border-radius: 8px;
      background: rgba(31, 111, 235, 0.14);
      color: var(--text-primary);
      padding: 11px 12px;
      text-align: left;
      font-family: inherit;
      cursor: default;
    }
    .session-card-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .session-card-detail {
      display: block;
      font-size: 11px;
      color: var(--text-secondary);
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    }
    .sidebar-footer {
      border-top: 1px solid var(--border);
      padding: 12px 10px;
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .top-bar {
      height: 56px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-secondary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 22px;
    }
    .top-bar-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
      width: 100%;
    }
    .page-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      white-space: nowrap;
    }
    .page-subtitle {
      font-size: 12px;
      color: var(--text-secondary);
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mobile-icon-btn {
      display: none;
      border: 1px solid var(--border);
      background: var(--bg-overlay);
      color: var(--text-primary);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      height: 32px;
      min-width: 32px;
      padding: 0 10px;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .content-area {
      flex: 1;
      display: flex;
      overflow: hidden;
      min-height: 0;
    }
    .flow-container {
      flex: 1;
      overflow: auto;
      padding: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .flow-svg {
      max-width: 100%;
      max-height: 100%;
      overflow: visible;
    }
    .flow-node { cursor: pointer; }
    .flow-node rect { transition: all 0.15s; }
    .flow-node:hover rect { filter: brightness(1.2); stroke: var(--text-primary); stroke-width: 2; }
    .flow-node.selected rect { stroke: var(--text-primary); stroke-width: 2.5; }
    .flow-node.dimmed rect, .flow-node.dimmed text { opacity: 0.2; }
    .tree-edge { stroke: #21262d; stroke-width: 1.5; fill: none; transition: opacity 0.15s; }
    .comm-edge { fill: none; stroke-width: 2; stroke-opacity: 0.55; transition: all 0.15s; }
    .tree-edge.dimmed, .comm-edge.dimmed { opacity: 0.08; }
    .comm-edge.highlighted { stroke-opacity: 1; stroke-width: 2.5; }
    .detail-panel {
      width: 0;
      min-width: 0;
      border-left: 1px solid var(--border);
      background: var(--bg-secondary);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: width 0.25s ease, min-width 0.25s ease;
      flex-shrink: 0;
    }
    .detail-panel.open {
      width: var(--panel-width);
      min-width: var(--panel-width);
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }
    .panel-title {
      font-size: 14px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .panel-close {
      width: 24px;
      height: 24px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: none;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .panel-close:hover {
      border-color: var(--border);
      background: var(--bg-overlay);
      color: var(--text-primary);
    }
    .panel-meta {
      padding: 11px 16px;
      border-bottom: 1px solid var(--border-dim);
      font-size: 12px;
      color: var(--text-secondary);
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    }
    .panel-body {
      overflow: auto;
      padding: 8px 0;
      flex: 1;
    }
    .accordion {
      border-bottom: 1px solid var(--border-dim);
    }
    .accordion-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      cursor: pointer;
      font-size: 12px;
      color: var(--text-secondary);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      user-select: none;
    }
    .accordion-header:hover {
      background: var(--bg-overlay);
      color: var(--text-primary);
    }
    .accordion-chevron {
      width: 14px;
      height: 14px;
      transition: transform 0.2s ease;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .accordion.open .accordion-chevron { transform: rotate(90deg); }
    .accordion-count {
      margin-left: auto;
      font-size: 11px;
      color: var(--text-muted);
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    }
    .accordion-body {
      display: none;
      padding: 0 16px 12px;
    }
    .accordion.open .accordion-body { display: block; }
    .row-item {
      font-size: 12px;
      color: var(--text-primary);
      padding: 6px 0;
      border-bottom: 1px solid var(--border-dim);
      line-height: 1.45;
    }
    .row-item:last-child { border-bottom: none; }
    .row-meta {
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 2px;
    }
    .badge {
      display: inline-block;
      background: var(--bg-overlay);
      color: var(--text-secondary);
      border-radius: 4px;
      padding: 2px 6px;
      margin-right: 6px;
      margin-bottom: 4px;
      font-size: 11px;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    }
    .output-preview, .error-box {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      max-height: 220px;
      overflow: auto;
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      color: var(--text-primary);
    }
    .error-box {
      border-color: rgba(248, 113, 113, 0.45);
      background: rgba(248, 113, 113, 0.08);
    }
    .empty-section {
      font-size: 11px;
      color: var(--text-muted);
      font-style: italic;
      padding-top: 4px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      padding-top: 4px;
    }
    .summary-item {
      font-size: 11px;
      color: var(--text-secondary);
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    }
    .mobile-backdrop {
      display: none;
    }
    @media (max-width: 960px) {
      .sidebar { width: 220px; }
      .detail-panel.open { width: 320px; min-width: 320px; }
    }
    @media (max-width: 900px) {
      body {
        height: 100dvh;
      }
      .app-container {
        height: 100dvh;
      }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        width: min(86vw, 320px);
        height: 100dvh;
        z-index: 20;
        transform: translateX(-102%);
        transition: transform 0.24s ease;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
      }
      .sidebar.mobile-open {
        transform: translateX(0);
      }
      .mobile-backdrop {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(1, 4, 9, 0.6);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
        z-index: 15;
      }
      .mobile-backdrop.open {
        opacity: 1;
        pointer-events: auto;
      }
      .main-content {
        width: 100%;
        min-width: 0;
      }
      .top-bar {
        height: auto;
        min-height: 56px;
        padding: 10px 12px;
        gap: 10px;
      }
      .top-bar-main {
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }
      .mobile-icon-btn {
        display: inline-flex;
        flex-shrink: 0;
      }
      .page-title {
        font-size: 14px;
      }
      .page-subtitle {
        width: 100%;
        font-size: 11px;
      }
      .content-area {
        flex-direction: column;
        overflow: auto;
      }
      .flow-container {
        align-items: flex-start;
        justify-content: flex-start;
        padding: 10px 8px 14px;
        min-height: 54vh;
      }
      .flow-svg {
        min-width: 720px;
      }
      .detail-panel {
        width: 100%;
        min-width: 100%;
        height: 0;
        min-height: 0;
        border-left: none;
        border-top: 1px solid var(--border);
        transition: height 0.25s ease;
      }
      .detail-panel.open {
        width: 100%;
        min-width: 100%;
        height: min(56vh, 520px);
      }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <aside class="sidebar">
      <div class="sidebar-header">Run Dashboard</div>
      <div class="sidebar-section-title">Sessions</div>
      <nav class="sidebar-nav" id="sessionsNav"></nav>
      <div class="sidebar-footer">
        Generated from Claude stream output.<br/>
        Click nodes for details.
      </div>
    </aside>
    <div class="mobile-backdrop" id="mobileBackdrop"></div>
    <main class="main-content">
      <header class="top-bar">
        <button class="mobile-icon-btn" id="sidebarToggle" type="button" aria-label="Open navigation">Menu</button>
        <div class="top-bar-main">
          <div class="page-title">Claude Task Report</div>
          <div class="page-subtitle" id="sessionInfo"></div>
        </div>
        <button class="mobile-icon-btn" id="focusLeadBtn" type="button" aria-label="Show run details">Overview</button>
      </header>
      <div class="content-area">
        <div class="flow-container" id="flowContainer"></div>
        <aside class="detail-panel" id="detailPanel">
          <div class="panel-header">
            <div class="panel-title" id="panelTitle">Node</div>
            <button class="panel-close" id="panelClose">x</button>
          </div>
          <div class="panel-meta" id="panelMeta"></div>
          <div class="panel-body" id="panelBody"></div>
        </aside>
      </div>
    </main>
  </div>

  <script>
    const DATA = ${serialized};
    const NS = 'http://www.w3.org/2000/svg';
    const COL_WIDTH = 210;
    const PAD = 64;
    const ROW_HEIGHT = 78;

    const state = {
      selectedNodeId: null,
      nodeLayout: new Map(),
      popup: null,
    };

    const flowContainer = document.getElementById('flowContainer');
    const detailPanel = document.getElementById('detailPanel');
    const panelTitle = document.getElementById('panelTitle');
    const panelMeta = document.getElementById('panelMeta');
    const panelBody = document.getElementById('panelBody');
    const panelClose = document.getElementById('panelClose');
    const sidebar = document.querySelector('.sidebar');
    const mobileBackdrop = document.getElementById('mobileBackdrop');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const focusLeadBtn = document.getElementById('focusLeadBtn');
    const sessionsNav = document.getElementById('sessionsNav');
    const sessionInfo = document.getElementById('sessionInfo');

    panelClose.addEventListener('click', closePanel);
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', () => {
        if (!sidebar || !mobileBackdrop) return;
        const isOpen = sidebar.classList.toggle('mobile-open');
        mobileBackdrop.classList.toggle('open', isOpen);
      });
    }
    if (focusLeadBtn) {
      focusLeadBtn.addEventListener('click', () => {
        openPanel('lead');
      });
    }
    if (mobileBackdrop) {
      mobileBackdrop.addEventListener('click', () => {
        closeMobileSidebar();
      });
    }
    window.addEventListener('resize', () => {
      if (window.innerWidth > 900) {
        closeMobileSidebar();
      }
    });
    renderSidebar();
    renderHeader();
    renderFlow();

    function renderSidebar() {
      const s = DATA.session;
      const start = new Date(s.startedAt);
      const label = \`\${s.runType} · \${s.toolCount} tools · \${s.inputCount} inputs\`;
      const detail = \`\${start.toLocaleDateString()} \${start.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} · \${formatDuration(s.durationMs)}\`;
      sessionsNav.innerHTML = \`
        <button class="session-card">
          <span class="session-card-label">\${escapeHtml(label)}</span>
          <span class="session-card-detail">\${escapeHtml(detail)}</span>
          <span class="session-card-detail">run: \${escapeHtml(s.id.slice(0, 12))}...</span>
        </button>
      \`;

      const card = sessionsNav.querySelector('.session-card');
      if (card) {
        card.addEventListener('click', () => {
          closeMobileSidebar();
          openPanel('lead');
        });
      }
    }

    function renderHeader() {
      const s = DATA.session;
      const parts = [];
      parts.push(\`duration: \${formatDuration(s.durationMs)}\`);
      if (s.workingDir) parts.push(\`dir: \${s.workingDir}\`);
      if (typeof s.threadId === 'number') parts.push(\`thread: \${s.threadId}\`);
      sessionInfo.textContent = parts.join(' · ');
    }

    function renderFlow() {
      if (!DATA.nodes.length) {
        flowContainer.innerHTML = '<div class="empty-section">No graph data available</div>';
        return;
      }

      const depth = new Map([
        ['start', 0],
        ['lead', 1],
        ...DATA.tools.map((tool, index) => [tool.id, 2 + index]),
        ['end', 3 + DATA.tools.length]
      ]);

      const svgHeight = Math.max(300, DATA.tools.length * ROW_HEIGHT + PAD * 2);
      const svgWidth = Math.max(900, (Math.max(...Array.from(depth.values())) + 1) * COL_WIDTH + PAD * 2);

      const nodeYs = buildNodeRows(svgHeight);
      state.nodeLayout.clear();

      for (const node of DATA.nodes) {
        const d = depth.get(node.id) || 0;
        const x = PAD + d * COL_WIDTH;
        let y = svgHeight / 2;
        if (node.id === 'start' || node.id === 'lead' || node.id === 'end') {
          y = svgHeight / 2;
        } else {
          y = nodeYs.shift() || svgHeight / 2;
        }
        const w = node.type === 'terminal' ? 86 : node.type === 'lead' ? 114 : 150;
        const h = node.type === 'terminal' ? 38 : 40;
        state.nodeLayout.set(node.id, { ...node, x, y, w, h });
      }

      const svg = createSvg(svgWidth, svgHeight);
      addDefs(svg);

      for (const edge of DATA.edges) {
        const from = state.nodeLayout.get(edge.from);
        const to = state.nodeLayout.get(edge.to);
        if (!from || !to) continue;
        const path = drawEdge(from, to, edge);
        svg.appendChild(path);
      }

      for (const node of DATA.nodes) {
        const layout = state.nodeLayout.get(node.id);
        if (!layout) continue;
        const g = drawNode(layout);
        svg.appendChild(g);
      }

      flowContainer.innerHTML = '';
      flowContainer.appendChild(svg);
      wireInteractions();
    }

    function buildNodeRows(totalHeight) {
      const count = Math.max(1, DATA.tools.length);
      const rows = [];
      const startY = (totalHeight - (count - 1) * ROW_HEIGHT) / 2;
      for (let i = 0; i < count; i++) {
        rows.push(startY + i * ROW_HEIGHT);
      }
      return rows;
    }

    function createSvg(width, height) {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'flow-svg');
      svg.setAttribute('viewBox', \`0 0 \${width} \${height}\`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      return svg;
    }

    function addDefs(svg) {
      const defs = document.createElementNS(NS, 'defs');
      defs.appendChild(createMarker('arrow-tree', '#30363d'));
      defs.appendChild(createMarker('arrow-comm', '#8b949e'));
      svg.appendChild(defs);
    }

    function createMarker(id, color) {
      const marker = document.createElementNS(NS, 'marker');
      marker.setAttribute('id', id);
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('refX', '8');
      marker.setAttribute('refY', '3');
      marker.setAttribute('orient', 'auto');
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', '0 0, 8 3, 0 6');
      poly.setAttribute('fill', color);
      marker.appendChild(poly);
      return marker;
    }

    function drawEdge(a, b, edge) {
      const path = document.createElementNS(NS, 'path');
      const x1 = a.x + a.w / 2;
      const y1 = a.y;
      const x2 = b.x - b.w / 2;
      const y2 = b.y;
      const cx = (x1 + x2) / 2;
      path.setAttribute('d', \`M \${x1} \${y1} C \${cx} \${y1}, \${cx} \${y2}, \${x2} \${y2}\`);
      path.setAttribute('data-from', edge.from);
      path.setAttribute('data-to', edge.to);
      path.setAttribute('marker-end', edge.kind === 'tree' ? 'url(#arrow-tree)' : 'url(#arrow-comm)');
      if (edge.kind === 'tree') {
        path.setAttribute('class', 'tree-edge');
      } else {
        path.setAttribute('class', 'comm-edge');
        path.setAttribute('stroke', '#8b949e');
      }
      return path;
    }

    function drawNode(node) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'flow-node');
      g.setAttribute('data-id', node.id);
      g.setAttribute('transform', \`translate(\${node.x}, \${node.y})\`);

      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(-node.w / 2));
      rect.setAttribute('y', String(-node.h / 2));
      rect.setAttribute('width', String(node.w));
      rect.setAttribute('height', String(node.h));
      rect.setAttribute('rx', node.type === 'terminal' ? String(node.h / 2) : '8');
      rect.setAttribute('fill', node.color);
      g.appendChild(rect);

      const text = document.createElementNS(NS, 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('fill', '#ffffff');
      text.setAttribute('font-size', '12');
      text.setAttribute('font-weight', '600');
      text.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');
      text.textContent = node.name;
      g.appendChild(text);

      return g;
    }

    function wireInteractions() {
      const nodeEls = flowContainer.querySelectorAll('.flow-node');
      const treeEdges = flowContainer.querySelectorAll('.tree-edge');
      const commEdges = flowContainer.querySelectorAll('.comm-edge');

      nodeEls.forEach((nodeEl) => {
        const nodeId = nodeEl.getAttribute('data-id');
        if (!nodeId) return;

        nodeEl.addEventListener('mouseenter', () => {
          nodeEls.forEach((n) => { if (n !== nodeEl) n.classList.add('dimmed'); });
          treeEdges.forEach((edge) => {
            const from = edge.getAttribute('data-from');
            const to = edge.getAttribute('data-to');
            if (from === nodeId || to === nodeId) edge.classList.remove('dimmed');
            else edge.classList.add('dimmed');
          });
          commEdges.forEach((edge) => {
            const from = edge.getAttribute('data-from');
            const to = edge.getAttribute('data-to');
            if (from === nodeId || to === nodeId) edge.classList.add('highlighted');
            else edge.classList.add('dimmed');
          });
        });

        nodeEl.addEventListener('mouseleave', () => {
          nodeEls.forEach((n) => n.classList.remove('dimmed'));
          treeEdges.forEach((edge) => edge.classList.remove('dimmed'));
          commEdges.forEach((edge) => {
            edge.classList.remove('highlighted');
            edge.classList.remove('dimmed');
          });
        });

        nodeEl.addEventListener('click', (event) => {
          event.stopPropagation();
          openPanel(nodeId);
        });
      });

      flowContainer.addEventListener('click', (event) => {
        if (event.target === flowContainer) closePanel();
      });
    }

    function openPanel(nodeId) {
      const node = state.nodeLayout.get(nodeId);
      if (!node) return;

      if (state.selectedNodeId) {
        const prev = flowContainer.querySelector(\`.flow-node[data-id="\${state.selectedNodeId}"]\`);
        if (prev) prev.classList.remove('selected');
      }
      state.selectedNodeId = nodeId;
      const selectedEl = flowContainer.querySelector(\`.flow-node[data-id="\${nodeId}"]\`);
      if (selectedEl) selectedEl.classList.add('selected');

      panelTitle.textContent = node.name;
      panelTitle.style.color = node.color;
      panelMeta.textContent = buildPanelMeta(nodeId);
      panelBody.innerHTML = buildPanelSections(nodeId);

      panelBody.querySelectorAll('.accordion-header').forEach((header) => {
        header.addEventListener('click', () => {
          const accordion = header.parentElement;
          if (accordion) accordion.classList.toggle('open');
        });
      });

      detailPanel.classList.add('open');
      closeMobileSidebar();

      if (window.innerWidth <= 900) {
        requestAnimationFrame(() => {
          detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
    }

    function closePanel() {
      detailPanel.classList.remove('open');
      if (state.selectedNodeId) {
        const selected = flowContainer.querySelector(\`.flow-node[data-id="\${state.selectedNodeId}"]\`);
        if (selected) selected.classList.remove('selected');
      }
      state.selectedNodeId = null;
    }

    function closeMobileSidebar() {
      if (!sidebar || !mobileBackdrop) return;
      sidebar.classList.remove('mobile-open');
      mobileBackdrop.classList.remove('open');
    }

    function buildPanelMeta(nodeId) {
      if (nodeId === 'start') return 'Run entry point';
      if (nodeId === 'end') return 'Run completion node';
      if (nodeId === 'lead') {
        return \`\${DATA.session.inputCount} inputs · \${DATA.session.eventCount} events · \${DATA.session.outputChars} chars output\`;
      }
      const tool = DATA.tools.find((t) => t.id === nodeId);
      if (!tool) return 'No details';
      return \`\${tool.count} calls · \${tool.successCount} ok · \${tool.failureCount} failed\`;
    }

    function buildPanelSections(nodeId) {
      if (nodeId === 'start' || nodeId === 'end') {
        return accordion('Summary', 1, \`<div class="summary-grid">
          <div class="summary-item">Run: \${escapeHtml(DATA.session.id)}</div>
          <div class="summary-item">Duration: \${escapeHtml(formatDuration(DATA.session.durationMs))}</div>
        </div>\`, true);
      }

      if (nodeId === 'lead') {
        const toolsBadges = DATA.tools.length
          ? DATA.tools.map((tool) => \`<span class="badge">\${escapeHtml(tool.name)}: \${tool.count}</span>\`).join('')
          : '<div class="empty-section">No tools used</div>';

        const inputRows = DATA.inputs.length
          ? DATA.inputs.map((input) => \`
            <div class="row-item">
              <div class="row-meta">\${escapeHtml(new Date(input.timestamp).toISOString())}\${input.isFollowup ? ' · follow-up' : ''}</div>
              <div>\${escapeHtml(input.text)}</div>
            </div>\`
          ).join('')
          : '<div class="empty-section">No inputs</div>';

        const eventRows = DATA.events.length
          ? DATA.events.map((event) => \`
            <div class="row-item">
              <div class="row-meta">+\${escapeHtml(formatOffset(event.offsetMs))} · \${escapeHtml(event.type)}</div>
              <div>\${escapeHtml(event.detail || '')}</div>
            </div>\`
          ).join('')
          : '<div class="empty-section">No events</div>';

        const outputBlock = \`<div class="output-preview">\${escapeHtml(DATA.outputPreview || 'No output captured')}</div>\`;
        const errorsBlock = DATA.errors.length
          ? \`<div class="error-box">\${escapeHtml(DATA.errors.join('\\n'))}</div>\`
          : '<div class="empty-section">No errors</div>';

        return [
          accordion('Tools', DATA.tools.length, toolsBadges, true),
          accordion('Inputs', DATA.inputs.length, inputRows, false),
          accordion('Events', DATA.events.length, eventRows, false),
          accordion('Output', DATA.outputPreview ? 1 : 0, outputBlock, false),
          accordion('Errors', DATA.errors.length, errorsBlock, false),
        ].join('');
      }

      const tool = DATA.tools.find((t) => t.id === nodeId);
      if (!tool) {
        return accordion('Summary', 1, '<div class="empty-section">No data</div>', true);
      }

      const summary = \`<div class="summary-grid">
        <div class="summary-item">Calls: \${tool.count}</div>
        <div class="summary-item">Avg Duration: \${formatOffset(tool.avgDurationMs)}</div>
        <div class="summary-item">Success: \${tool.successCount}</div>
        <div class="summary-item">Failures: \${tool.failureCount}</div>
      </div>\`;

      const durations = tool.durations.length
        ? tool.durations.map((duration) => \`<span class="badge">\${escapeHtml(formatOffset(duration))}</span>\`).join('')
        : '<div class="empty-section">No timing data</div>';

      const samples = tool.samples.length
        ? tool.samples.map((sample) => \`<div class="row-item"><div>\${escapeHtml(sample)}</div></div>\`).join('')
        : '<div class="empty-section">No input payloads captured</div>';

      return [
        accordion('Summary', 1, summary, true),
        accordion('Durations', tool.durations.length, durations, false),
        accordion('Input Samples', tool.samples.length, samples, false),
      ].join('');
    }

    function accordion(title, count, body, openByDefault) {
      return \`<div class="accordion\${openByDefault ? ' open' : ''}">
        <div class="accordion-header">
          <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
          <span>\${escapeHtml(title)}</span>
          <span class="accordion-count">\${count}</span>
        </div>
        <div class="accordion-body">\${body}</div>
      </div>\`;
    }

    function formatDuration(ms) {
      if (ms < 1000) return \`\${ms}ms\`;
      if (ms < 60000) return \`\${(ms / 1000).toFixed(1)}s\`;
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      return \`\${minutes}m \${seconds}s\`;
    }

    function formatOffset(ms) {
      if (ms < 1000) return \`\${ms}ms\`;
      if (ms < 60000) return \`\${(ms / 1000).toFixed(1)}s\`;
      return \`\${(ms / 60000).toFixed(1)}m\`;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  </script>
</body>
</html>`;
  }

  private static buildToolSummaries(toolEvents: RunToolEvent[]): ToolSummary[] {
    const map = new Map<string, ToolSummary>();

    for (const event of toolEvents) {
      let entry = map.get(event.name);
      if (!entry) {
        entry = {
          id: `tool-${map.size + 1}`,
          name: event.name,
          count: 0,
          successCount: 0,
          failureCount: 0,
          avgDurationMs: 0,
          durations: [],
          samples: [],
        };
        map.set(event.name, entry);
      }

      entry.count += 1;
      if (event.success === true) {
        entry.successCount += 1;
      } else if (event.success === false) {
        entry.failureCount += 1;
      }

      if (typeof event.startedAt === 'number' && typeof event.endedAt === 'number') {
        const duration = Math.max(0, event.endedAt - event.startedAt);
        entry.durations.push(duration);
      }

      if (event.input) {
        const cleaned = event.input.replace(/\s+/g, ' ').trim();
        if (cleaned && entry.samples.length < 8) {
          entry.samples.push(cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned);
        }
      }
    }

    for (const item of map.values()) {
      if (item.durations.length > 0) {
        const total = item.durations.reduce((sum, value) => sum + value, 0);
        item.avgDurationMs = Math.round(total / item.durations.length);
      }
    }

    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }

  private static getLastEventTimestamp(run: RunRecord): number | null {
    const timestamps = [
      ...run.events.map((event) => event.timestamp),
      ...run.toolEvents.flatMap((tool) => [tool.startedAt, tool.endedAt ?? 0]),
      ...run.inputs.map((input) => input.timestamp),
    ].filter(Boolean);

    if (!timestamps.length) return null;
    return Math.max(...timestamps);
  }

  private static escapeForScript(value: string): string {
    return value.replace(/<\//g, '<\\/');
  }

  private static escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
