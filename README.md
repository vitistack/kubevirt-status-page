# KubeVirt Status Page

This project is a status page application that provides a graphical view of KubeVirt nodes and the virtual machines (VMs) scheduled on each node. The application groups machines in clusters and displays allocation per node in a graph format.

## Project Structure

```
kubevirt-status-page
├── cmd
│   └── server
│       └── main.go          # Entry point of the Go application
├── internal
│   ├── kubevirt
│   │   ├── client.go        # KubeVirt client implementation
│   │   └── types.go         # Data structures for KubeVirt nodes and VMs
│   ├── cluster
│   │   └── aggregator.go     # Logic to aggregate data from KubeVirt nodes
│   └── sse
│       └── handler.go       # Server-Sent Events (SSE) handler
├── web
│   ├── static
│   │   ├── index.html       # Main HTML file for the frontend
│   │   ├── style.css        # Styles for the frontend
│   │   └── app.js           # JavaScript code for frontend logic
│   └── embed.go             # Embedding static files into the Go binary
├── Dockerfile                # Instructions for building the Docker image
├── go.mod                   # Go module definition file
├── go.sum                   # Checksums for module dependencies
├── Makefile                 # Build and deployment commands
└── README.md                # Project documentation
```

## Setup Instructions

1. **Clone the repository:**
   ```
   git clone https://github.com/vitistack/kubevirt-status-page.git
   cd kubevirt-status-page
   ```

2. **Build the application:**
   ```
   make build
   ```

3. **Run the application:**
   ```
   make run
   ```

4. **Access the status page:**
   Open your web browser and navigate to `http://localhost:8080` to view the KubeVirt status page.

## Helm Chart Installation

The application can be deployed to a Kubernetes cluster using the Helm chart.

### Prerequisites

- Kubernetes cluster with KubeVirt installed
- Helm 3.x

### Install from OCI registry

```bash
helm install kubevirt-status-page oci://ghcr.io/vitistack/helm/kubevirt-status-page --version <version>
```

### Install from source

```bash
helm install kubevirt-status-page ./charts/kubevirt-status-page
```

### Configuration

Key values can be overridden during installation:

```bash
helm install kubevirt-status-page oci://ghcr.io/vitistack/helm/kubevirt-status-page \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=status.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=ImplementationSpecific
```

| Parameter | Description | Default |
|---|---|---|
| `replicaCount` | Number of replicas | `1` |
| `image.repository` | Container image | `ghcr.io/vitistack/kubevirt-status-page` |
| `image.tag` | Image tag (defaults to chart appVersion) | `""` |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `80` |
| `ingress.enabled` | Enable ingress | `false` |
| `kubeContext` | Kubernetes context (empty for in-cluster) | `""` |
| `kubeconfig.secretName` | Name of secret containing kubeconfig | `""` |
| `kubeconfig.secretKey` | Key in secret with kubeconfig data | `"kubeconfig"` |
| `hub.enabled` | Run as hub (no k8s access needed) | `false` |
| `hub.token` | Shared secret for agent authentication | `""` |
| `hub.existingSecret` | Existing secret with hub token (key: `token`) | `""` |
| `agent.datacenterName` | Label for this datacenter | `""` |
| `agent.hubURL` | Central hub URL to push reports to | `""` |
| `agent.hubToken` | Token for authenticating with the hub | `""` |
| `agent.hubTokenSecret` | Existing secret with hub token (key: `token`) | `""` |

### Using an external kubeconfig

By default the application uses the in-cluster service account to access the Kubernetes API. To monitor a **remote** KubeVirt cluster, provide a kubeconfig file via a Kubernetes secret:

1. Create the secret from your kubeconfig file:

   ```bash
   kubectl create secret generic kubevirt-kubeconfig \
     --from-file=kubeconfig=/path/to/remote-kubeconfig
   ```

2. Install the chart referencing the secret:

   ```bash
   helm install kubevirt-status-page oci://ghcr.io/vitistack/helm/kubevirt-status-page \
     --set kubeconfig.secretName=kubevirt-kubeconfig
   ```

3. Optionally select a specific context from the kubeconfig:

   ```bash
   helm install kubevirt-status-page oci://ghcr.io/vitistack/helm/kubevirt-status-page \
     --set kubeconfig.secretName=kubevirt-kubeconfig \
     --set kubeContext=admin@my-cluster
   ```

If the secret key is named something other than `kubeconfig`, set `kubeconfig.secretKey` accordingly.

## Multi-Datacenter Setup

The application supports a hub & agent architecture for monitoring multiple datacenters from a single dashboard. The same binary runs in two modes:

- **Agent mode** (default): queries the local KubeVirt cluster, serves a local dashboard, and optionally pushes data to a central hub.
- **Hub mode**: receives reports from agents, stores them in memory, and serves a combined multi-datacenter dashboard.

Each agent's local dashboard remains fully functional even if the hub is unreachable.

```
  ┌─────────────┐
  │  DC1 Agent  │──POST /api/report──┐
  │ (local dash)│                    │
  └─────────────┘                    ▼
  ┌─────────────┐              ┌──────────┐
  │  DC2 Agent  │──────────────│   Hub    │──▶ Combined dashboard
  │ (local dash)│              └──────────┘
  └─────────────┘                    ▲
  ┌─────────────┐                    │
  │  DC3 Agent  │────────────────────┘
  │ (local dash)│
  └─────────────┘
```

### Environment Variables

| Variable | Mode | Description |
|---|---|---|
| `HUB_MODE` | Hub | Set to `true` to run as hub |
| `HUB_TOKEN` | Both | Shared secret for `Authorization: Bearer` authentication |
| `DATACENTER_NAME` | Agent | Name of this datacenter (e.g. `dc-west-1`) |
| `HUB_URL` | Agent | URL of the central hub (e.g. `https://hub.example.com`) |

### Deploying the Hub

The hub does not need access to any Kubernetes cluster. Deploy it as a standalone instance:

```bash
helm install status-hub oci://ghcr.io/vitistack/helm/kubevirt-status-page \
  --set hub.enabled=true \
  --set hub.token="my-shared-secret" \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=status-hub.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=ImplementationSpecific
```

### Deploying an Agent

Deploy one agent per datacenter. Each agent needs access to the local KubeVirt cluster:

```bash
helm install status-agent oci://ghcr.io/vitistack/helm/kubevirt-status-page \
  --set agent.datacenterName="dc-west-1" \
  --set agent.hubURL="https://status-hub.example.com" \
  --set agent.hubToken="my-shared-secret"
```

For production, store the token in a Kubernetes secret:

```bash
kubectl create secret generic hub-token --from-literal=token="my-shared-secret"

helm install status-agent oci://ghcr.io/vitistack/helm/kubevirt-status-page \
  --set agent.datacenterName="dc-west-1" \
  --set agent.hubURL="https://status-hub.example.com" \
  --set agent.hubTokenSecret=hub-token
```

### Stale Detection

If an agent stops reporting, the hub marks that datacenter as **stale** after 30 seconds. Stale datacenters appear greyed out with a "STALE" badge on the hub dashboard.

### Authentication

All agent-to-hub communication uses a shared Bearer token. The agent sends `Authorization: Bearer <token>` on every `POST /api/report`. The hub validates the token and rejects requests with a missing or invalid token (HTTP 401).

## Local Development with Hub & Agent

You can test the full multi-datacenter setup locally using two terminal windows.

### Prerequisites

- Go 1.24+
- A kubeconfig with access to a KubeVirt cluster

### 1. Start the Hub

The hub does not need k8s access. Run it on port 9090:

```bash
export HUB_MODE=true
export HUB_TOKEN=dev-secret
export PORT=9090
go run cmd/server/main.go
```

The hub dashboard is available at `http://localhost:9090`.

### 2. Start an Agent

In a second terminal, start an agent pointing at your KubeVirt cluster and the local hub:

```bash
export DATACENTER_NAME=my-dc
export HUB_URL=http://localhost:9090
export HUB_TOKEN=dev-secret
export KUBECONFIG=~/.kube/config
export KUBE_CONTEXT=admin@my-cluster
go run cmd/server/main.go
```

The agent's local dashboard is at `http://localhost:8080`. Within 5 seconds, the hub at `http://localhost:9090` will show the datacenter.

### 3. Simulate Multiple Datacenters

To simulate multiple agents, start additional agents on different ports with different datacenter names:

```bash
# Terminal 3
export DATACENTER_NAME=dc-east
export HUB_URL=http://localhost:9090
export HUB_TOKEN=dev-secret
export PORT=8081
export KUBECONFIG=~/.kube/config
export KUBE_CONTEXT=admin@other-cluster
go run cmd/server/main.go
```

The hub will now show both `my-dc` and `dc-east` in the combined dashboard.

### Uninstall

```bash
helm uninstall kubevirt-status-page
```

## Usage

The application connects to the KubeVirt cluster and retrieves information about nodes and VMs. It uses Server-Sent Events (SSE) to provide real-time updates to the frontend, ensuring that the status page reflects the current state of the cluster.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.