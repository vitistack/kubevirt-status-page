(function() {
    "use strict";

    let cpuChart = null;
    let memChart = null;
    const dcCharts = {}; // { dcName: { cpu: Chart, mem: Chart } }

    // --- Initial load via REST ---
    fetch("/api/status")
        .then(r => r.json())
        .then(data => render(data))
        .catch(err => console.error("Initial fetch failed:", err));

    // --- SSE for live updates ---
    let sseErrorCount = 0;
    let hasReceivedMessage = false;

    function connectSSE() {
        const es = new EventSource("/events");
        const badge = document.getElementById("connection-status");

        if (!hasReceivedMessage) {
            badge.textContent = "Connecting";
            badge.className = "connection-badge reconnecting";
        }

        es.onopen = () => {
            sseErrorCount = 0;
            if (hasReceivedMessage) {
                badge.textContent = "Live";
                badge.className = "connection-badge connected";
            }
        };

        es.onmessage = (e) => {
            try {
                sseErrorCount = 0;
                hasReceivedMessage = true;
                badge.textContent = "Live";
                badge.className = "connection-badge connected";
                const data = JSON.parse(e.data);
                render(data);
            } catch (err) {
                console.error("SSE parse error:", err);
            }
        };

        es.onerror = () => {
            sseErrorCount++;
            if (sseErrorCount <= 1) {
                // First miss: stay Live, just retry
            } else if (sseErrorCount <= 3) {
                badge.textContent = "Reconnecting";
                badge.className = "connection-badge reconnecting";
            } else {
                badge.textContent = "Disconnected";
                badge.className = "connection-badge disconnected";
            }
            es.close();
            setTimeout(connectSSE, 3000);
        };
    }
    connectSSE();

    // --- Render everything ---
    function render(data) {
        if (data.datacenters) {
            // Hub mode: multi-datacenter payload
            document.getElementById("updated").textContent = "Updated: " + new Date(data.updated).toLocaleTimeString();
            renderHubOverview(data.datacenters);
            renderDatacenters(data.datacenters);
        } else {
            // Agent mode: single datacenter
            const dcLabel = data.datacenter || "";
            document.getElementById("updated").textContent = "Updated: " + new Date(data.updated).toLocaleTimeString();
            renderOverview(data);
            renderClusters(data.clusters || []);
            renderNodes(data.nodes || []);
            renderCharts(data.nodes || []);
        }
    }

    // --- Overview summary bar ---
    function renderOverview(data) {
        const el = document.getElementById("overview-section");
        const nodes = data.nodes || [];
        const clusters = data.clusters || [];

        let totVMs = 0, runVMs = 0, badVMs = 0, warnVMs = 0;
        let totCPU = 0, useCPU = 0, totMemMB = 0, useMemMB = 0;
        let readyN = 0;

        nodes.forEach(n => {
            if (n.status === "Ready") readyN++;
            totCPU += n.cpuAllocatable || n.cpuCapacity || 0;
            totMemMB += n.memAllocMB || n.memoryCapMB || 0;
            (n.vms || []).forEach(v => {
                totVMs++;
                if (v.status === "Running") { runVMs++; useCPU += v.cpuCores; useMemMB += v.memoryMB; }
                else if (["Pending","Starting","Stopping","Provisioning"].includes(v.status)) warnVMs++;
                else badVMs++;
            });
        });

        const cpuPct = totCPU > 0 ? Math.round((useCPU / totCPU) * 100) : 0;
        const memPct = totMemMB > 0 ? Math.round((useMemMB / totMemMB) * 100) : 0;
        const readyClusters = clusters.filter(c => (c.vms || []).every(v => v.status === "Running")).length;

        const redundantNodes = calcRedundancy(nodes, totCPU, useCPU, totMemMB, useMemMB);

        function pctCls(p) { return p < 60 ? "ok" : p < 85 ? "warn" : "err"; }

        el.innerHTML = `<div class="overview-bar">
            <div class="ov-item">
                <span class="ov-label">NODES</span>
                <span class="ov-value ${readyN === nodes.length ? "ok" : "warn"}">${readyN}/${nodes.length}</span>
                <span class="ov-sub">ready</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">CLUSTERS</span>
                <span class="ov-value ${readyClusters === clusters.length ? "ok" : "warn"}">${readyClusters}/${clusters.length}</span>
                <span class="ov-sub">healthy</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">REDUNDANCY</span>
                <span class="ov-value ${redundantNodes >= 2 ? "ok" : redundantNodes >= 1 ? "warn" : "err"}">${redundantNodes}</span>
                <span class="ov-sub">node${redundantNodes === 1 ? "" : "s"} can fail</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">VMS</span>
                <span class="ov-value ${runVMs === totVMs ? "ok" : "warn"}">${runVMs}/${totVMs}</span>
                <span class="ov-sub">running</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">PROBLEMS</span>
                <span class="ov-value ${badVMs > 0 ? "err" : "ok"}">${badVMs}</span>
                <span class="ov-sub">${warnVMs} pending</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">CLUSTER CPU</span>
                <span class="ov-value ${pctCls(cpuPct)}">${cpuPct}%</span>
                <span class="ov-sub">${useCPU} / ${totCPU} cores</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">CLUSTER MEM</span>
                <span class="ov-value ${pctCls(memPct)}">${memPct}%</span>
                <span class="ov-sub">${(useMemMB/1024).toFixed(0)} / ${(totMemMB/1024).toFixed(0)} GB</span>
            </div>
        </div>`;
    }

    // --- Clusters ---
    const COMPACT_THRESHOLD = 6;

    function renderClusters(clusters) {
        const container = document.getElementById("clusters-container");
        container.innerHTML = "";

        if (clusters.length > COMPACT_THRESHOLD) {
            renderClustersCompact(clusters, container);
        } else {
            renderClustersExpanded(clusters, container);
        }
    }

    function renderClustersCompact(clusters, container) {
        container.className = "clusters-table-wrap";
        const table = document.createElement("table");
        table.className = "clusters-table";
        table.innerHTML = `<thead><tr>
            <th>Cluster</th><th>VMs</th><th>Running</th><th>vCPU</th><th>Memory</th><th>Nodes</th><th>Status</th>
        </tr></thead>`;
        const tbody = document.createElement("tbody");
        clusters.forEach(cluster => {
            const totalCPU = cluster.vms.reduce((s, v) => s + v.cpuCores, 0);
            const totalMem = cluster.vms.reduce((s, v) => s + v.memoryMB, 0);
            const running = cluster.vms.filter(v => v.status === "Running").length;
            const errors = cluster.vms.filter(v => v.status && (v.status.toLowerCase().includes("error") || v.status.toLowerCase().includes("unschedulable"))).length;
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="cluster-name-cell">⎈ ${escapeHtml(cluster.name)}</td>
                <td>${cluster.vms.length}</td>
                <td>${running}/${cluster.vms.length}</td>
                <td>${totalCPU}</td>
                <td>${(totalMem / 1024).toFixed(1)} GB</td>
                <td>${cluster.nodes.length}</td>
                <td>${errors > 0 ? '<span class="status-dot error"></span>' + errors + ' error' : '<span class="status-dot ok"></span>OK'}</td>
            `;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        container.appendChild(table);
    }

    function renderClustersExpanded(clusters, container) {
        container.className = "clusters-grid";
        clusters.forEach(cluster => {
            const card = document.createElement("div");
            card.className = "cluster-card";

            const totalCPU = cluster.vms.reduce((s, v) => s + v.cpuCores, 0);
            const totalMem = cluster.vms.reduce((s, v) => s + v.memoryMB, 0);
            const running = cluster.vms.filter(v => v.status === "Running").length;

            card.innerHTML = `
                <h3>${escapeHtml(cluster.name)}</h3>
                <div class="cluster-vm-list">
                    ${cluster.vms.map(vm => `<span class="vm-pill ${statusClass(vm.status)}" title="${escapeHtml(vm.namespace)}/${escapeHtml(vm.name)}">${shortName(vm.name)}<br><small>${vm.status}</small></span>`).join("")}
                </div>
                <div class="cluster-stats">
                    ${running}/${cluster.vms.length} running &middot;
                    ${totalCPU} vCPU &middot;
                    ${(totalMem / 1024).toFixed(1)} GB memory &middot;
                    ${cluster.nodes.length} node(s)
                </div>
            `;
            container.appendChild(card);
        });
    }

    // --- Nodes ---
    function renderNodes(nodes) {
        const container = document.getElementById("nodes-container");
        const existingCards = container.querySelectorAll(".node-card");
        const existingMap = {};
        existingCards.forEach(card => {
            const name = card.getAttribute("data-node");
            if (name) existingMap[name] = card;
        });

        const seen = new Set();
        nodes.forEach(node => {
            seen.add(node.name);
            const vmCPU = (node.vms || []).reduce((s, v) => s + v.cpuCores, 0);
            const vmMem = (node.vms || []).reduce((s, v) => s + v.memoryMB, 0);
            const cpuLimit = node.cpuAllocatable || node.cpuCapacity;
            const memLimit = node.memAllocMB || node.memoryCapMB;
            const cpuPct = cpuLimit > 0 ? (vmCPU / cpuLimit * 100) : 0;
            const memPct = memLimit > 0 ? (vmMem / memLimit * 100) : 0;

            let card = existingMap[node.name];
            if (card) {
                // Update existing card in-place
                const cpuLabel = card.querySelector(".resource-item:nth-child(1) .resource-label");
                const cpuBar = card.querySelector(".resource-item:nth-child(1) .resource-bar-fill");
                const memLabel = card.querySelector(".resource-item:nth-child(2) .resource-label");
                const memBar = card.querySelector(".resource-item:nth-child(2) .resource-bar-fill");
                if (cpuLabel) cpuLabel.textContent = `CPU (${vmCPU}/${cpuLimit} cores used by VMs)`;
                if (cpuBar) { cpuBar.style.width = Math.min(cpuPct,100) + "%"; cpuBar.className = "resource-bar-fill " + barColor(cpuPct); }
                if (memLabel) memLabel.textContent = `Memory (${(vmMem/1024).toFixed(1)}/${(memLimit/1024).toFixed(1)} GB used by VMs)`;
                if (memBar) { memBar.style.width = Math.min(memPct,100) + "%"; memBar.className = "resource-bar-fill " + barColor(memPct); }
                // Update status badge
                const statusBadge = card.querySelector(".node-status");
                if (statusBadge) { statusBadge.textContent = node.status; statusBadge.className = "node-status " + node.status.toLowerCase(); }
                // Update VM list
                const vmTitle = card.querySelector(".node-vms-title");
                if (vmTitle) vmTitle.textContent = `Virtual Machines (${(node.vms||[]).length})`;
                const vmList = card.querySelector(".node-vm-list");
                if (vmList) {
                    vmList.innerHTML = (node.vms || []).map(vm => `
                        <div class="vm-card">
                            <div class="vm-card-name">${escapeHtml(vm.name)}</div>
                            <div class="vm-card-details">
                                <span class="vm-card-status ${statusClass(vm.status)}">${vm.status}</span>
                                <span>${vm.cpuCores} vCPU</span>
                                <span>${(vm.memoryMB/1024).toFixed(0)} GB</span>
                            </div>
                        </div>
                    `).join("");
                }
            } else {
                // Create new card
                card = document.createElement("div");
                card.className = "node-card";
                card.setAttribute("data-node", node.name);
                card.innerHTML = `
                    <div class="node-header">
                        <div class="node-name">
                            ${escapeHtml(node.name)}
                            ${(node.roles || []).map(r => `<span class="role-badge">${r}</span>`).join("")}
                        </div>
                        <span class="node-status ${node.status.toLowerCase()}">${node.status}</span>
                    </div>
                    <div class="node-resources">
                        <div class="resource-item">
                            <span class="resource-label">CPU (${vmCPU}/${cpuLimit} cores used by VMs)</span>
                            <div class="resource-bar"><div class="resource-bar-fill ${barColor(cpuPct)}" style="width:${Math.min(cpuPct,100)}%"></div></div>
                        </div>
                        <div class="resource-item">
                            <span class="resource-label">Memory (${(vmMem/1024).toFixed(1)}/${(memLimit/1024).toFixed(1)} GB used by VMs)</span>
                            <div class="resource-bar"><div class="resource-bar-fill ${barColor(memPct)}" style="width:${Math.min(memPct,100)}%"></div></div>
                        </div>
                    </div>
                    <div class="node-vms">
                        <div class="node-vms-title">Virtual Machines (${(node.vms||[]).length})</div>
                        <div class="node-vm-list">
                            ${(node.vms || []).map(vm => `
                                <div class="vm-card">
                                    <div class="vm-card-name">${escapeHtml(vm.name)}</div>
                                    <div class="vm-card-details">
                                        <span class="vm-card-status ${statusClass(vm.status)}">${vm.status}</span>
                                        <span>${vm.cpuCores} vCPU</span>
                                        <span>${(vm.memoryMB/1024).toFixed(0)} GB</span>
                                    </div>
                                </div>
                            `).join("")}
                        </div>
                    </div>
                `;
                container.appendChild(card);
            }
        });
        // Remove cards for nodes that no longer exist
        existingCards.forEach(card => {
            if (!seen.has(card.getAttribute("data-node"))) card.remove();
        });
    }

    // --- Charts ---
    function renderCharts(nodes) {
        const labels = nodes.map(n => n.name);

        // CPU data - use allocatable (scheduling limit)
        const cpuAllocatable = nodes.map(n => n.cpuAllocatable || n.cpuCapacity);
        const cpuUsed = nodes.map(n => (n.vms || []).reduce((s, v) => s + v.cpuCores, 0));
        const cpuFree = cpuAllocatable.map((cap, i) => Math.max(0, cap - cpuUsed[i]));

        // Memory data (in GB) - use allocatable (scheduling limit)
        const memAllocatable = nodes.map(n => +((n.memAllocMB || n.memoryCapMB) / 1024).toFixed(1));
        const memUsed = nodes.map(n => +((n.vms || []).reduce((s, v) => s + v.memoryMB, 0) / 1024).toFixed(1));
        const memFree = memAllocatable.map((cap, i) => +Math.max(0, cap - memUsed[i]).toFixed(1));

        const cpuChartOpts = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { stacked: true, ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } },
                y: { stacked: true, beginAtZero: true, ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } }
            },
            plugins: {
                legend: { labels: { color: "#cbd5e1" } }
            }
        };

        // CPU chart - update in place if exists
        if (cpuChart) {
            cpuChart.data.labels = labels;
            cpuChart.data.datasets[0].data = cpuUsed;
            cpuChart.data.datasets[1].data = cpuFree;
            cpuChart.update("none");
        } else {
            const cpuCtx = document.getElementById("cpu-chart").getContext("2d");
            cpuChart = new Chart(cpuCtx, {
                type: "bar",
                data: {
                    labels: labels,
                    datasets: [
                        { label: "VM vCPUs", data: cpuUsed, backgroundColor: "#3b82f6" },
                        { label: "Available", data: cpuFree, backgroundColor: "#1e3a5f" }
                    ]
                },
                options: cpuChartOpts
            });
        }

        // Memory chart - update in place if exists
        const memChartOpts = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { stacked: true, ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } },
                y: { stacked: true, beginAtZero: true, ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } }
            },
            plugins: {
                legend: { labels: { color: "#cbd5e1" } }
            }
        };
        if (memChart) {
            memChart.data.labels = labels;
            memChart.data.datasets[0].data = memUsed;
            memChart.data.datasets[1].data = memFree;
            memChart.update("none");
        } else {
            const memCtx = document.getElementById("mem-chart").getContext("2d");
            memChart = new Chart(memCtx, {
                type: "bar",
                data: {
                    labels: labels,
                    datasets: [
                        { label: "VM Memory (GB)", data: memUsed, backgroundColor: "#8b5cf6" },
                        { label: "Available (GB)", data: memFree, backgroundColor: "#3b1f6e" }
                    ]
                },
                options: memChartOpts
            });
        }
    }

    // --- Helpers ---
    function statusClass(status) {
        if (!status) return "unknown";
        const s = status.toLowerCase();
        if (s === "running") return "running";
        if (s.includes("error") || s.includes("unschedulable")) return "error";
        if (s === "scheduling" || s === "pending") return "scheduling";
        return "unknown";
    }

    function barColor(pct) {
        if (pct < 50) return "low";
        if (pct < 80) return "medium";
        return "high";
    }

    function shortName(name) {
        // Show last two segments for readability
        const parts = name.split("-");
        if (parts.length <= 2) return name;
        return parts.slice(-2).join("-");
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // --- Redundancy calculation ---
    function calcRedundancy(nodes, totCPU, useCPU, totMemMB, useMemMB) {
        const sortedCaps = nodes.map(n => ({
            cpu: n.cpuAllocatable || n.cpuCapacity || 0,
            mem: n.memAllocMB || n.memoryCapMB || 0
        })).sort((a, b) => (a.cpu + a.mem) - (b.cpu + b.mem));
        let spareCPU = totCPU - useCPU;
        let spareMem = totMemMB - useMemMB;
        let count = 0;
        for (const cap of sortedCaps) {
            if (spareCPU >= cap.cpu && spareMem >= cap.mem) {
                count++;
                spareCPU -= cap.cpu;
                spareMem -= cap.mem;
            } else {
                break;
            }
        }
        return count;
    }

    // --- Hub mode: multi-datacenter rendering ---

    function renderHubOverview(datacenters) {
        const el = document.getElementById("overview-section");
        let totNodes = 0, readyNodes = 0, totVMs = 0, runVMs = 0, badVMs = 0;
        let totCPU = 0, useCPU = 0, totMemMB = 0, useMemMB = 0;
        let totClusters = 0, readyClusters = 0;

        datacenters.forEach(dc => {
            const nodes = dc.nodes || [];
            const clusters = dc.clusters || [];
            totClusters += clusters.length;
            readyClusters += clusters.filter(c => (c.vms || []).every(v => v.status === "Running")).length;
            nodes.forEach(n => {
                totNodes++;
                if (n.status === "Ready") readyNodes++;
                totCPU += n.cpuAllocatable || n.cpuCapacity || 0;
                totMemMB += n.memAllocMB || n.memoryCapMB || 0;
                (n.vms || []).forEach(v => {
                    totVMs++;
                    if (v.status === "Running") { runVMs++; useCPU += v.cpuCores; useMemMB += v.memoryMB; }
                    else if (!["Pending","Starting","Stopping","Provisioning"].includes(v.status)) badVMs++;
                });
            });
        });

        const cpuPct = totCPU > 0 ? Math.round((useCPU / totCPU) * 100) : 0;
        const memPct = totMemMB > 0 ? Math.round((useMemMB / totMemMB) * 100) : 0;
        const staleDCs = datacenters.filter(d => d.stale).length;
        // Aggregate redundancy across all nodes from all DCs
        const allNodes = datacenters.flatMap(dc => dc.nodes || []);
        const totalRedundancy = calcRedundancy(allNodes, totCPU, useCPU, totMemMB, useMemMB);
        function pctCls(p) { return p < 60 ? "ok" : p < 85 ? "warn" : "err"; }

        el.innerHTML = `<div class="overview-bar">
            <div class="ov-item">
                <span class="ov-label">DATACENTERS</span>
                <span class="ov-value ${staleDCs > 0 ? "warn" : "ok"}">${datacenters.length - staleDCs}/${datacenters.length}</span>
                <span class="ov-sub">reporting</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">NODES</span>
                <span class="ov-value ${readyNodes === totNodes ? "ok" : "warn"}">${readyNodes}/${totNodes}</span>
                <span class="ov-sub">ready</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">CLUSTERS</span>
                <span class="ov-value ${readyClusters === totClusters ? "ok" : "warn"}">${readyClusters}/${totClusters}</span>
                <span class="ov-sub">healthy</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">VMS</span>
                <span class="ov-value ${runVMs === totVMs ? "ok" : "warn"}">${runVMs}/${totVMs}</span>
                <span class="ov-sub">running</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">PROBLEMS</span>
                <span class="ov-value ${badVMs > 0 ? "err" : "ok"}">${badVMs}</span>
                <span class="ov-sub">errors</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">TOTAL CPU</span>
                <span class="ov-value ${pctCls(cpuPct)}">${cpuPct}%</span>
                <span class="ov-sub">${useCPU} / ${totCPU} cores</span>
            </div>
            <div class="ov-item">
                <span class="ov-label">TOTAL MEM</span>
                <span class="ov-value ${pctCls(memPct)}">${memPct}%</span>
                <span class="ov-sub">${(useMemMB/1024).toFixed(0)} / ${(totMemMB/1024).toFixed(0)} GB</span>
            </div>
        </div>`;
    }

    function renderDatacenters(datacenters) {
        // Hide single-DC sections
        const chartsSection = document.getElementById("charts-section");
        const nodesSection = document.getElementById("nodes-section");
        const clustersSection = document.getElementById("clusters-section");
        chartsSection.style.display = "none";
        nodesSection.style.display = "none";
        clustersSection.style.display = "none";

        // Get or create DC container
        let dcContainer = document.getElementById("dc-container");
        if (!dcContainer) {
            dcContainer = document.createElement("section");
            dcContainer.id = "dc-container";
            const main = document.querySelector("main");
            main.appendChild(dcContainer);
        }

        // Track which DCs still exist
        const activeDCs = new Set(datacenters.map(dc => dc.datacenter || "unknown"));

        // Remove charts for DCs that no longer exist
        for (const key of Object.keys(dcCharts)) {
            if (!activeDCs.has(key)) {
                if (dcCharts[key].cpu) dcCharts[key].cpu.destroy();
                if (dcCharts[key].mem) dcCharts[key].mem.destroy();
                delete dcCharts[key];
            }
        }

        // Build or update each DC card
        datacenters.forEach(dc => {
            const dcName = dc.datacenter || "unknown";
            const cardId = "dc-card-" + dcName.replace(/[^a-zA-Z0-9]/g, "-");
            const nodes = dc.nodes || [];
            const clusters = dc.clusters || [];
            const runVMs = nodes.reduce((s, n) => s + (n.vms || []).filter(v => v.status === "Running").length, 0);
            const totVMs = nodes.reduce((s, n) => s + (n.vms || []).length, 0);
            const readyN = nodes.filter(n => n.status === "Ready").length;
            let useCPU = 0, totCPU = 0, useMemMB = 0, totMemMB = 0;
            nodes.forEach(n => {
                totCPU += n.cpuAllocatable || n.cpuCapacity || 0;
                totMemMB += n.memAllocMB || n.memoryCapMB || 0;
                (n.vms || []).forEach(v => {
                    if (v.status === "Running") { useCPU += v.cpuCores; useMemMB += v.memoryMB; }
                });
            });
            const cpuPct = totCPU > 0 ? Math.round((useCPU / totCPU) * 100) : 0;
            const memPct = totMemMB > 0 ? Math.round((useMemMB / totMemMB) * 100) : 0;
            const staleClass = dc.stale ? " dc-stale" : "";
            const staleBadge = dc.stale ? '<span class="dc-stale-badge">STALE</span>' : "";
            const readyClusters = clusters.filter(c => (c.vms || []).every(v => v.status === "Running")).length;
            const dcRedundancy = calcRedundancy(nodes, totCPU, useCPU, totMemMB, useMemMB);
            function pctCls(p) { return p < 60 ? "ok" : p < 85 ? "warn" : "err"; }

            let card = document.getElementById(cardId);
            if (!card) {
                card = document.createElement("div");
                card.id = cardId;
                card.className = "dc-card" + staleClass;
                card.innerHTML = `
                    <div class="dc-header">
                        <h2 class="dc-name">${escapeHtml(dcName)}${staleBadge}</h2>
                        <span class="dc-updated"></span>
                    </div>
                    <div class="overview-bar dc-overview"></div>
                    <div class="charts-row dc-charts">
                        <div class="chart-box">
                            <h3>CPU Allocation per Node</h3>
                            <canvas id="${cardId}-cpu"></canvas>
                        </div>
                        <div class="chart-box">
                            <h3>Memory Allocation per Node (GB)</h3>
                            <canvas id="${cardId}-mem"></canvas>
                        </div>
                    </div>
                `;
                dcContainer.appendChild(card);
            }

            // Update header
            card.className = "dc-card" + staleClass;
            card.querySelector(".dc-name").innerHTML = escapeHtml(dcName) + staleBadge;
            card.querySelector(".dc-updated").textContent = "Updated: " + new Date(dc.updated).toLocaleTimeString();

            // Update overview bar
            card.querySelector(".dc-overview").innerHTML = `
                <div class="ov-item"><span class="ov-label">NODES</span><span class="ov-value ${readyN === nodes.length ? "ok" : "warn"}">${readyN}/${nodes.length}</span></div>
                <div class="ov-item"><span class="ov-label">CLUSTERS</span><span class="ov-value ${readyClusters === clusters.length ? "ok" : "warn"}">${readyClusters}/${clusters.length}</span></div>
                <div class="ov-item"><span class="ov-label">REDUNDANCY</span><span class="ov-value ${dcRedundancy >= 2 ? "ok" : dcRedundancy >= 1 ? "warn" : "err"}">${dcRedundancy}</span><span class="ov-sub">node${dcRedundancy === 1 ? "" : "s"} can fail</span></div>
                <div class="ov-item"><span class="ov-label">VMS</span><span class="ov-value ${runVMs === totVMs ? "ok" : "warn"}">${runVMs}/${totVMs}</span></div>
                <div class="ov-item"><span class="ov-label">CPU</span><span class="ov-value ${pctCls(cpuPct)}">${cpuPct}%</span><span class="ov-sub">${useCPU} / ${totCPU} cores</span></div>
                <div class="ov-item"><span class="ov-label">MEM</span><span class="ov-value ${pctCls(memPct)}">${memPct}%</span><span class="ov-sub">${(useMemMB/1024).toFixed(0)} / ${(totMemMB/1024).toFixed(0)} GB</span></div>
            `;

            // Update charts
            renderDCCharts(dcName, cardId, nodes);
        });

        // Remove cards for DCs that no longer exist
        const existing = dcContainer.querySelectorAll(".dc-card");
        existing.forEach(card => {
            const name = card.id.replace("dc-card-", "").replace(/-/g, ".");
            // If no DC matches this card id, remove it
            if (!datacenters.some(dc => card.id === "dc-card-" + (dc.datacenter || "unknown").replace(/[^a-zA-Z0-9]/g, "-"))) {
                card.remove();
            }
        });
    }

    function renderDCCharts(dcName, cardId, nodes) {
        const labels = nodes.map(n => n.name);
        const cpuAllocatable = nodes.map(n => n.cpuAllocatable || n.cpuCapacity);
        const cpuUsed = nodes.map(n => (n.vms || []).reduce((s, v) => s + v.cpuCores, 0));
        const cpuFree = cpuAllocatable.map((cap, i) => Math.max(0, cap - cpuUsed[i]));
        const memAllocatable = nodes.map(n => +((n.memAllocMB || n.memoryCapMB) / 1024).toFixed(1));
        const memUsed = nodes.map(n => +((n.vms || []).reduce((s, v) => s + v.memoryMB, 0) / 1024).toFixed(1));
        const memFree = memAllocatable.map((cap, i) => +Math.max(0, cap - memUsed[i]).toFixed(1));

        const chartOpts = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { stacked: true, ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } },
                y: { stacked: true, beginAtZero: true, ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } }
            },
            plugins: { legend: { labels: { color: "#cbd5e1" } } }
        };

        if (!dcCharts[dcName]) dcCharts[dcName] = {};

        // CPU chart
        if (dcCharts[dcName].cpu) {
            dcCharts[dcName].cpu.data.labels = labels;
            dcCharts[dcName].cpu.data.datasets[0].data = cpuUsed;
            dcCharts[dcName].cpu.data.datasets[1].data = cpuFree;
            dcCharts[dcName].cpu.update("none");
        } else {
            const cpuCanvas = document.getElementById(cardId + "-cpu");
            if (cpuCanvas) {
                dcCharts[dcName].cpu = new Chart(cpuCanvas.getContext("2d"), {
                    type: "bar",
                    data: {
                        labels: labels,
                        datasets: [
                            { label: "VM vCPUs", data: cpuUsed, backgroundColor: "#3b82f6" },
                            { label: "Available", data: cpuFree, backgroundColor: "#1e3a5f" }
                        ]
                    },
                    options: chartOpts
                });
            }
        }

        // Memory chart
        if (dcCharts[dcName].mem) {
            dcCharts[dcName].mem.data.labels = labels;
            dcCharts[dcName].mem.data.datasets[0].data = memUsed;
            dcCharts[dcName].mem.data.datasets[1].data = memFree;
            dcCharts[dcName].mem.update("none");
        } else {
            const memCanvas = document.getElementById(cardId + "-mem");
            if (memCanvas) {
                dcCharts[dcName].mem = new Chart(memCanvas.getContext("2d"), {
                    type: "bar",
                    data: {
                        labels: labels,
                        datasets: [
                            { label: "VM Memory (GB)", data: memUsed, backgroundColor: "#8b5cf6" },
                            { label: "Available (GB)", data: memFree, backgroundColor: "#3b1f6e" }
                        ]
                    },
                    options: chartOpts
                });
            }
        }
    }
})();
