(function() {
    "use strict";

    let cpuChart = null;
    let memChart = null;

    // --- Initial load via REST ---
    fetch("/api/status")
        .then(r => r.json())
        .then(data => render(data))
        .catch(err => console.error("Initial fetch failed:", err));

    // --- SSE for live updates ---
    function connectSSE() {
        const es = new EventSource("/events");
        const badge = document.getElementById("connection-status");

        es.onopen = () => {
            badge.textContent = "Live";
            badge.className = "connection-badge connected";
        };

        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                render(data);
            } catch (err) {
                console.error("SSE parse error:", err);
            }
        };

        es.onerror = () => {
            badge.textContent = "Disconnected";
            badge.className = "connection-badge disconnected";
            es.close();
            setTimeout(connectSSE, 3000);
        };
    }
    connectSSE();

    // --- Render everything ---
    function render(data) {
        document.getElementById("updated").textContent = "Updated: " + new Date(data.updated).toLocaleTimeString();
        renderClusters(data.clusters || []);
        renderNodes(data.nodes || []);
        renderCharts(data.nodes || []);
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
})();
