(function() {
    "use strict";

    const canvas = document.getElementById("topology-canvas");
    const ctx = canvas.getContext("2d");
    let currentData = null;

    function resize() {
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
        if (currentData) draw(currentData);
    }
    window.addEventListener("resize", resize);
    resize();

    // --- Data fetching ---
    fetch("/api/status")
        .then(r => r.json())
        .then(data => { currentData = data; draw(data); })
        .catch(err => console.error("Initial fetch failed:", err));

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
                currentData = data;
                document.getElementById("updated").textContent = "Updated: " + new Date(data.updated).toLocaleTimeString();
                draw(data);
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

    // --- Color helpers ---
    function dcColor(dc) {
        const nodes = dc.nodes || [];
        if (nodes.length === 0) return "#64748b";
        const allReady = nodes.every(n => n.status === "Ready");
        const anyDown = nodes.some(n => n.status !== "Ready");
        if (dc.stale) return "#ef4444";
        if (anyDown) return "#eab308";
        return "#22c55e";
    }

    function nodeColor(status) {
        return status === "Ready" ? "#3b82f6" : "#ef4444";
    }

    // --- Drawing ---
    function draw(data) {
        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Build datacenter list from either hub or agent payload
        let datacenters;
        if (data.datacenters) {
            datacenters = data.datacenters;
        } else {
            // Agent mode: single datacenter
            datacenters = [{
                datacenter: data.datacenter || "Datacenter",
                nodes: data.nodes || [],
                clusters: data.clusters || [],
                updated: data.updated,
                stale: false
            }];
        }

        drawTopology(datacenters, W, H);
    }

    function drawTopology(datacenters, W, H) {
        if (datacenters.length === 0) {
            ctx.fillStyle = "#64748b";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No datacenters reporting", W / 2, H / 2);
            return;
        }

        const padding = 40;
        const dcBoxW = 220;
        const dcBoxH = 80;
        const nodeBoxW = 220;
        const nodeBoxH = 85;

        // Collect all nodes across all DCs, tagged with DC name
        const allNodes = [];
        datacenters.forEach(dc => {
            (dc.nodes || []).forEach(n => {
                allNodes.push({ node: n, dcName: dc.datacenter || "unknown" });
            });
        });

        if (allNodes.length === 0 && datacenters.length === 0) {
            ctx.fillStyle = "#64748b";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No data", W / 2, H / 2);
            return;
        }

        // Positions: DCs on left, nodes in two columns on right grouped by DC
        const dcX = padding + dcBoxW / 2;
        const colGap = 16;
        const dcGap = 24; // vertical gap between DC groups on the node side
        const nodeCol1X = W - padding - nodeBoxW / 2 - nodeBoxW - colGap;
        const nodeCol2X = W - padding - nodeBoxW / 2;

        const dcSpacing = Math.min(120, (H - padding * 2) / Math.max(datacenters.length, 1));

        // Group nodes by DC, calculate per-group layout
        const dcGroups = datacenters.map(dc => {
            const nodes = allNodes.filter(e => e.dcName === (dc.datacenter || "unknown"));
            const col1 = nodes.filter((_, i) => i % 2 === 0);
            const col2 = nodes.filter((_, i) => i % 2 === 1);
            return { dcName: dc.datacenter || "unknown", nodes, col1Count: col1.length, col2Count: col2.length, maxRows: Math.max(col1.length, col2.length) };
        });

        const totalRows = dcGroups.reduce((s, g) => s + g.maxRows, 0);
        const totalGaps = Math.max(dcGroups.length - 1, 0);
        const availH = H - padding * 2 - totalGaps * dcGap;
        const nodeSpacing = Math.min(110, availH / Math.max(totalRows, 1));

        const dcTotalH = datacenters.length * dcSpacing;
        const nodeTotalH = totalRows * nodeSpacing + totalGaps * dcGap;

        const dcStartY = Math.max(padding, (H - dcTotalH) / 2);
        const nodeStartY = Math.max(padding, (H - nodeTotalH) / 2);

        const dcPositions = datacenters.map((dc, i) => ({
            x: dcX, y: dcStartY + i * dcSpacing + dcSpacing / 2, dc: dc
        }));

        // Position nodes grouped by DC
        const nodePositions = [];
        let currentY = nodeStartY;
        dcGroups.forEach(group => {
            const nodes = allNodes.filter(e => e.dcName === group.dcName);
            nodes.forEach((entry, i) => {
                const colIdx = i % 2;
                const rowIdx = Math.floor(i / 2);
                const colX = colIdx === 0 ? nodeCol1X : nodeCol2X;
                nodePositions.push({
                    x: colX, y: currentY + rowIdx * nodeSpacing + nodeSpacing / 2,
                    node: entry.node, dcName: entry.dcName
                });
            });
            currentY += group.maxRows * nodeSpacing + dcGap;
        });

        // Draw connections: DC → its nodes
        dcPositions.forEach(dp => {
            const dcName = dp.dc.datacenter || "unknown";
            const color = dcColor(dp.dc);
            nodePositions.forEach(np => {
                if (np.dcName === dcName) {
                    drawBezier(dp.x + dcBoxW / 2, dp.y, np.x - nodeBoxW / 2, np.y, color, 0.3);
                }
            });
        });

        // Draw DC boxes
        dcPositions.forEach(dp => drawDCBox(dp, dcBoxW, dcBoxH));

        // Draw node boxes
        nodePositions.forEach(np => drawNodeBox(np, nodeBoxW, nodeBoxH));

        // Legend
        drawLegend(padding, H);
    }

    // --- Shared drawing helpers ---

    function drawBezier(x1, y1, x2, y2, color, alpha) {
        const cpx = (x1 + x2) / 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(cpx, y1, cpx, y2, x2, y2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    function drawDCBox(dp, boxW, boxH) {
        const dc = dp.dc;
        const x = dp.x - boxW / 2;
        const y = dp.y - boxH / 2;
        const color = dcColor(dc);
        const nodes = dc.nodes || [];
        const clusters = dc.clusters || [];

        // Box
        ctx.fillStyle = "#1e293b";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, boxW, boxH, 8);
        ctx.fill();
        ctx.stroke();

        // DC name
        const dcName = dc.datacenter || "unknown";
        ctx.fillStyle = dc.stale ? "#ef4444" : "#38bdf8";
        ctx.font = "bold 13px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(dcName, x + 12, y + 16);

        if (dc.stale) {
            ctx.fillStyle = "#7f1d1d";
            roundRect(ctx, x + boxW - 52, y + 8, 42, 16, 3);
            ctx.fill();
            ctx.fillStyle = "#fca5a5";
            ctx.font = "bold 9px -apple-system, sans-serif";
            ctx.fillText("STALE", x + boxW - 48, y + 16);
        }

        // Stats
        const readyNodes = nodes.filter(n => n.status === "Ready").length;
        let totVMs = 0, runVMs = 0;
        nodes.forEach(n => (n.vms || []).forEach(v => { totVMs++; if (v.status === "Running") runVMs++; }));

        ctx.fillStyle = readyNodes === nodes.length ? "#6ee7b7" : "#fcd34d";
        ctx.font = "11px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(readyNodes + "/" + nodes.length + " nodes ready", x + 12, y + 36);

        ctx.fillStyle = runVMs === totVMs ? "#6ee7b7" : "#fcd34d";
        ctx.fillText(runVMs + "/" + totVMs + " VMs running", x + 12, y + 52);

        ctx.fillStyle = "#94a3b8";
        ctx.font = "10px -apple-system, sans-serif";
        ctx.fillText(clusters.length + " clusters", x + 12, y + 68);
    }

    function drawNodeBox(np, boxW, boxH) {
        const n = np.node;
        const x = np.x - boxW / 2;
        const y = np.y - boxH / 2;

        // Box
        ctx.fillStyle = "#1e293b";
        ctx.strokeStyle = nodeColor(n.status);
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, boxW, boxH, 8);
        ctx.fill();
        ctx.stroke();

        // Status dot + Name
        ctx.beginPath();
        ctx.arc(x + 14, y + 14, 5, 0, Math.PI * 2);
        ctx.fillStyle = n.status === "Ready" ? "#22c55e" : "#ef4444";
        ctx.fill();

        ctx.fillStyle = "#f1f5f9";
        ctx.font = "bold 12px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(n.name, x + 26, y + 14);

        // VM count
        const vmCount = (n.vms || []).length;
        ctx.fillStyle = "#94a3b8";
        ctx.font = "10px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(vmCount + " VMs", x + boxW - 10, y + 14);
        ctx.textAlign = "left";

        // CPU bar
        const vmCPU = (n.vms || []).reduce((s, v) => s + v.cpuCores, 0);
        const cpuLimit = n.cpuAllocatable || n.cpuCapacity || 1;
        const cpuPct = Math.min(vmCPU / cpuLimit, 1);
        const barX = x + 10;
        const barW = boxW - 20;
        const barH = 7;
        const cpuBarY = y + 34;

        ctx.fillStyle = "#cbd5e1";
        ctx.font = "bold 9px -apple-system, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillText("CPU", barX, cpuBarY - 2);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(vmCPU + "/" + cpuLimit, barX + barW, cpuBarY - 2);
        ctx.textAlign = "left";

        roundRect(ctx, barX, cpuBarY, barW, barH, 3);
        ctx.fillStyle = "#334155";
        ctx.fill();
        if (cpuPct > 0) {
            roundRect(ctx, barX, cpuBarY, Math.max(4, barW * cpuPct), barH, 3);
            ctx.fillStyle = cpuPct < 0.5 ? "#22c55e" : cpuPct < 0.8 ? "#eab308" : "#ef4444";
            ctx.fill();
        }

        // Memory bar
        const vmMem = (n.vms || []).reduce((s, v) => s + v.memoryMB, 0);
        const memLimit = n.memAllocMB || n.memoryCapMB || 1;
        const memPct = Math.min(vmMem / memLimit, 1);
        const memBarY = cpuBarY + 20;

        ctx.fillStyle = "#cbd5e1";
        ctx.font = "bold 9px -apple-system, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillText("MEM", barX, memBarY - 2);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText((vmMem / 1024).toFixed(0) + "/" + (memLimit / 1024).toFixed(0) + " GB", barX + barW, memBarY - 2);
        ctx.textAlign = "left";

        roundRect(ctx, barX, memBarY, barW, barH, 3);
        ctx.fillStyle = "#334155";
        ctx.fill();
        if (memPct > 0) {
            roundRect(ctx, barX, memBarY, Math.max(4, barW * memPct), barH, 3);
            ctx.fillStyle = memPct < 0.5 ? "#22c55e" : memPct < 0.8 ? "#eab308" : "#ef4444";
            ctx.fill();
        }
    }

    function drawLegend(padding, H) {
        ctx.font = "11px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const legendY = H - 18;
        const items = [
            { color: "#22c55e", label: "Healthy" },
            { color: "#eab308", label: "Warning" },
            { color: "#ef4444", label: "Error" },
            { color: "#3b82f6", label: "Node Ready" },
            { color: "#64748b", label: "Unknown" }
        ];
        let lx = padding;
        items.forEach(item => {
            ctx.beginPath();
            ctx.arc(lx + 5, legendY, 4, 0, Math.PI * 2);
            ctx.fillStyle = item.color;
            ctx.fill();
            ctx.fillStyle = "#94a3b8";
            ctx.fillText(item.label, lx + 14, legendY);
            lx += ctx.measureText(item.label).width + 28;
        });
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
})();
