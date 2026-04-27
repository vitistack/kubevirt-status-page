(function () {
    "use strict";

    const summaryEl = document.getElementById("topology-summary");
    const gridEl = document.getElementById("topology-grid");
    const updatedEl = document.getElementById("updated");
    const connEl = document.getElementById("connection-status");

    let currentData = null;

    // ---- Status helpers ----
    function isOK(status) { return status === "Running"; }
    function isWarn(status) {
        return status === "Pending" || status === "Starting" || status === "Stopping" || status === "Provisioning";
    }
    function statusClass(status) {
        if (isOK(status)) return "ok";
        if (isWarn(status)) return "warn";
        return "bad";
    }
    function pctClass(p) {
        if (p < 0.6) return "ok";
        if (p < 0.85) return "warn";
        return "err";
    }

    // ---- Render ----
    function render(data) {
        currentData = data;
        const nodes = data.nodes || [];

        // Compute summary
        let totVMs = 0, runVMs = 0, badVMs = 0, warnVMs = 0;
        let totCPU = 0, useCPU = 0, totMemMB = 0, useMemMB = 0;
        let readyN = 0;
        nodes.forEach(n => {
            if (n.status === "Ready") readyN++;
            totCPU += n.cpuAllocatable || n.cpuCapacity || 0;
            totMemMB += n.memAllocMB || n.memoryCapMB || 0;
            (n.vms || []).forEach(v => {
                totVMs++;
                if (isOK(v.status)) { runVMs++; useCPU += v.cpuCores; useMemMB += v.memoryMB; }
                else if (isWarn(v.status)) warnVMs++;
                else badVMs++;
            });
        });

        // Unscheduled
        const onNodeKeys = new Set();
        nodes.forEach(n => (n.vms || []).forEach(vm => onNodeKeys.add(vm.namespace + "/" + vm.name)));
        const unscheduled = [];
        (data.clusters || []).forEach(c => (c.vms || []).forEach(vm => {
            const k = vm.namespace + "/" + vm.name;
            if (!onNodeKeys.has(k) && !vm.nodeName) {
                unscheduled.push(vm);
                onNodeKeys.add(k);
            }
        }));

        const cpuPct = totCPU > 0 ? useCPU / totCPU : 0;
        const memPct = totMemMB > 0 ? useMemMB / totMemMB : 0;

        // ---- Summary bar ----
        summaryEl.innerHTML = `
            ${summaryItem("Nodes", `${readyN}/${nodes.length}`, readyN === nodes.length ? "ok" : "warn", "ready")}
            ${summaryItem("VMs", totVMs, "", `${runVMs} running`)}
            ${summaryItem("Problems", badVMs, badVMs > 0 ? "err" : "ok", `${warnVMs} pending`)}
            ${summaryItem("Cluster CPU", Math.round(cpuPct * 100) + "%", pctClass(cpuPct), `${useCPU} / ${totCPU} cores`)}
            ${summaryItem("Cluster MEM", Math.round(memPct * 100) + "%", pctClass(memPct), `${(useMemMB/1024).toFixed(0)} / ${(totMemMB/1024).toFixed(0)} GB`)}
            ${unscheduled.length > 0 ? summaryItem("Unscheduled", unscheduled.length, "warn", "no node assigned") : ""}
        `;

        // ---- Node cards (sorted: most-loaded first, problem nodes float to top) ----
        const sortedNodes = nodes.slice().sort((a, b) => {
            // NotReady first
            if ((a.status === "Ready") !== (b.status === "Ready")) return a.status === "Ready" ? 1 : -1;
            // Then by problem VM count desc
            const aBad = (a.vms || []).filter(v => !isOK(v.status) && !isWarn(v.status)).length;
            const bBad = (b.vms || []).filter(v => !isOK(v.status) && !isWarn(v.status)).length;
            if (aBad !== bBad) return bBad - aBad;
            // Then by CPU saturation desc
            const aCPU = (a.vms || []).reduce((s, v) => s + v.cpuCores, 0) / (a.cpuAllocatable || a.cpuCapacity || 1);
            const bCPU = (b.vms || []).reduce((s, v) => s + v.cpuCores, 0) / (b.cpuAllocatable || b.cpuCapacity || 1);
            return bCPU - aCPU;
        });

        gridEl.innerHTML = sortedNodes.map(renderNodeCard).join("") +
            (unscheduled.length ? renderUnscheduledCard(unscheduled) : "");

        // Update header timestamp
        if (updatedEl) updatedEl.textContent = "Updated " + new Date().toLocaleTimeString();
    }

    function summaryItem(label, value, cls, sub) {
        return `<div class="summary-item">
            <span class="summary-label">${escapeHtml(label)}</span>
            <span class="summary-value ${cls || ""}">${escapeHtml(String(value))}</span>
            ${sub ? `<span class="summary-sub">${escapeHtml(sub)}</span>` : ""}
        </div>`;
    }

    function renderNodeCard(n) {
        const vms = n.vms || [];
        const vmCPU = vms.reduce((s, v) => s + v.cpuCores, 0);
        const cpuLimit = n.cpuAllocatable || n.cpuCapacity || 1;
        const cpuPct = Math.min(vmCPU / cpuLimit, 1);
        const vmMem = vms.reduce((s, v) => s + v.memoryMB, 0);
        const memLimit = n.memAllocMB || n.memoryCapMB || 1;
        const memPct = Math.min(vmMem / memLimit, 1);
        const errCnt = vms.filter(v => !isOK(v.status) && !isWarn(v.status)).length;
        const warnCnt = vms.filter(v => isWarn(v.status)).length;

        // Sort VMs: bad → warn → ok (largest first within group)
        const sortedVMs = vms.slice().sort((a, b) => {
            const ra = isOK(a.status) ? 2 : isWarn(a.status) ? 1 : 0;
            const rb = isOK(b.status) ? 2 : isWarn(b.status) ? 1 : 0;
            if (ra !== rb) return ra - rb;
            return (b.cpuCores + b.memoryMB / 1024) - (a.cpuCores + a.memoryMB / 1024);
        });

        const nodeClass = n.status === "Ready" ? "ready" : "notready";

        return `
        <div class="node-card ${nodeClass}">
            <div class="node-header">
                <div class="node-name">
                    <span class="node-status-dot ${nodeClass}"></span>
                    ${escapeHtml(n.name)}
                </div>
                <div class="node-badges">
                    ${errCnt > 0 ? `<span class="node-badge err">${errCnt} issue${errCnt === 1 ? "" : "s"}</span>` : ""}
                    ${warnCnt > 0 ? `<span class="node-badge" style="background:#3f2d09;color:#fde68a">${warnCnt} pending</span>` : ""}
                    <span class="node-badge">${vms.length} VM${vms.length === 1 ? "" : "s"}</span>
                </div>
            </div>

            <div class="node-sat">
                ${satRow("CPU", cpuPct, `${vmCPU} / ${cpuLimit} cores`)}
                ${satRow("MEM", memPct, `${(vmMem/1024).toFixed(0)} / ${(memLimit/1024).toFixed(0)} GB`)}
            </div>

            <div class="node-vms">
                ${vms.length === 0
                    ? `<div class="vm-empty">No VMs scheduled</div>`
                    : sortedVMs.map(vmTile).join("")}
            </div>
        </div>`;
    }

    function satRow(label, pct, detail) {
        const cls = pctClass(pct);
        return `<div class="sat-row">
            <div class="sat-head">
                <span class="sat-label">${label}</span>
                <span class="sat-pct">${Math.round(pct * 100)}%</span>
            </div>
            <div class="sat-bar"><div class="sat-fill ${cls}" style="width:${(pct * 100).toFixed(1)}%"></div></div>
            <span class="sat-detail">${escapeHtml(detail)}</span>
        </div>`;
    }

    function vmTile(vm) {
        const st = statusClass(vm.status);
        const cls = st === "ok" ? "" : st === "warn" ? "warn" : "bad";
        const cpu = vm.cpuCores || 0;
        const memG = ((vm.memoryMB || 0) / 1024).toFixed(0);
        const showStatus = st !== "ok";
        return `<div class="vm-tile ${cls}" title="${escapeHtml(vm.namespace || "")}/${escapeHtml(vm.name)} — ${escapeHtml(vm.status)}">
            <span class="vm-name">${escapeHtml(vm.name)}</span>
            <span class="vm-meta">
                <span>${cpu}c</span>
                <span>${memG}G</span>
                ${showStatus ? `<span class="vm-status-text">${escapeHtml(vm.status)}</span>` : ""}
            </span>
        </div>`;
    }

    function renderUnscheduledCard(vms) {
        const sorted = vms.slice().sort((a, b) =>
            (b.cpuCores + b.memoryMB / 1024) - (a.cpuCores + a.memoryMB / 1024));
        return `<div class="node-card unscheduled-card">
            <div class="node-header">
                <div class="node-name">
                    <span class="node-status-dot" style="background:#eab308;box-shadow:0 0 6px #eab30888"></span>
                    Unscheduled VMs
                </div>
                <div class="node-badges">
                    <span class="node-badge" style="background:#3f2d09;color:#fde68a">${vms.length} pending placement</span>
                </div>
            </div>
            <div class="node-vms">
                ${sorted.map(vmTile).join("")}
            </div>
        </div>`;
    }

    function escapeHtml(s) {
        const d = document.createElement("div");
        d.appendChild(document.createTextNode(s == null ? "" : String(s)));
        return d.innerHTML;
    }

    // ---- Data ----
    fetch("/api/status")
        .then(r => r.json())
        .then(render)
        .catch(err => console.error("Initial fetch failed:", err));

    // SSE
    try {
        const es = new EventSource("/events");
        es.onopen = () => {
            if (connEl) { connEl.textContent = "Live"; connEl.className = "connection-badge connected"; }
        };
        es.onerror = () => {
            if (connEl) { connEl.textContent = "Disconnected"; connEl.className = "connection-badge disconnected"; }
        };
        es.onmessage = (ev) => {
            try { render(JSON.parse(ev.data)); } catch (e) { console.error(e); }
        };
    } catch (e) {
        console.error("SSE setup failed:", e);
    }
})();
