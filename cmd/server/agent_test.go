package main

import (
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func testVMI(name, node string, migratable bool) *unstructured.Unstructured {
	status := "True"
	if !migratable {
		status = "False"
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": name, "namespace": "ns", "resourceVersion": "1",
			"managedFields": []any{map[string]any{"manager": "x"}}},
		"spec": map[string]any{"domain": map[string]any{
			"cpu":    map[string]any{"cores": int64(4)},
			"memory": map[string]any{"guest": "8Gi"},
		}},
		"status": map[string]any{"nodeName": node, "phase": "Running",
			"conditions": []any{map[string]any{"type": "LiveMigratable", "status": status}}},
	}}
}

func testVM(name, printable, mem string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": name, "namespace": "ns"},
		"spec": map[string]any{"template": map[string]any{"spec": map[string]any{"domain": map[string]any{
			"resources": map[string]any{"requests": map[string]any{"memory": mem}}}}}},
		"status": map[string]any{"printableStatus": printable},
	}}
}

func testNode(name string, ready bool, roles ...string) *corev1.Node {
	n := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: map[string]string{"kubernetes.io/hostname": name}}}
	for _, r := range roles {
		n.Labels["node-role.kubernetes.io/"+r] = ""
	}
	st := corev1.ConditionFalse
	if ready {
		st = corev1.ConditionTrue
	}
	n.Status.Conditions = []corev1.NodeCondition{
		{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionFalse},
		{Type: corev1.NodeReady, Status: st, LastHeartbeatTime: metav1.Now()},
	}
	n.Status.Capacity = corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("32"), corev1.ResourceMemory: resource.MustParse("128Gi"), corev1.ResourcePods: resource.MustParse("110")}
	n.Status.Allocatable = corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("120Gi")}
	n.Status.Images = []corev1.ContainerImage{{Names: []string{"big/image"}}}
	return n
}

func mustTransform(t *testing.T, f func(any) (any, error), obj any) any {
	t.Helper()
	out, err := f(obj)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f(out)
	if err != nil || !reflect.DeepEqual(again, out) {
		t.Fatalf("transform not idempotent: %v", err)
	}
	return out
}

func TestTransformVMI(t *testing.T) {
	s := mustTransform(t, transformVMI, testVMI("cl1-wrk0", "n1", false)).(*vmiSlim)
	want := vmiInfo{NodeName: "n1", Phase: "Running", Cluster: inferClusterName("cl1-wrk0", nil), Cores: 4, MemMB: 8192, LiveMigratable: false}
	if s.Info != want {
		t.Fatalf("got %+v want %+v", s.Info, want)
	}
	if s.ManagedFields != nil || s.Name != "cl1-wrk0" || s.Namespace != "ns" {
		t.Fatalf("unexpected meta %+v", s.ObjectMeta)
	}
	if !mustTransform(t, transformVMI, testVMI("x", "n1", true)).(*vmiSlim).Info.LiveMigratable {
		t.Fatal("expected live migratable")
	}
}

func TestTransformNodeKeepsOnlyNeededFields(t *testing.T) {
	n := mustTransform(t, transformNode, testNode("n1", true, "worker")).(*corev1.Node)
	if len(n.Labels) != 1 || len(n.Status.Conditions) != 1 || len(n.Status.Images) != 0 || len(n.Status.Capacity) != 2 {
		t.Fatalf("node not slimmed: %+v", n)
	}
	if !n.Status.Conditions[0].LastHeartbeatTime.IsZero() {
		t.Fatal("heartbeat timestamp should be dropped")
	}
}

func TestBuildStatus(t *testing.T) {
	var nodes, vms, vmis []any
	for _, n := range []*corev1.Node{testNode("n2", true), testNode("n1", false, "worker"), testNode("cp", true, "control-plane")} {
		o, _ := transformNode(n)
		nodes = append(nodes, o)
	}
	for _, v := range []*unstructured.Unstructured{testVMI("b-wrk0", "n1", true), testVMI("a-wrk0", "n2", true), testVMI("a-ctp0", "cp", true)} {
		o, _ := transformVMI(v)
		vmis = append(vmis, o)
	}
	vm, _ := transformVM(testVM("a-wrk0", "Migrating", "16Gi"))
	vms = append(vms, vm)

	d := buildStatus(nodes, vms, vmis)

	if len(d.Nodes) != 2 || d.Nodes[0].Name != "n1" || d.Nodes[1].Name != "n2" {
		t.Fatalf("control-plane must be skipped and nodes sorted: %+v", d.Nodes)
	}
	if d.Nodes[0].Status != "NotReady" || d.Nodes[1].Status != "Ready" {
		t.Fatalf("bad node status: %+v", d.Nodes)
	}
	if got := d.Nodes[1].Roles; len(got) != 1 || got[0] != "worker" {
		t.Fatalf("roles should default to worker: %v", got)
	}
	if d.Nodes[1].CPUAllocatable != 96 || d.Nodes[1].MemoryCapMB != 131072 || d.Nodes[1].MemAllocMB != 122880 {
		t.Fatalf("bad capacity: %+v", d.Nodes[1])
	}
	if countVMs(d.Clusters) != 3 {
		t.Fatalf("VMs on control-plane nodes must still be listed in clusters, got %d", countVMs(d.Clusters))
	}
	for i := 1; i < len(d.Clusters); i++ {
		if d.Clusters[i-1].Name > d.Clusters[i].Name {
			t.Fatal("clusters not sorted")
		}
	}
	vmOnN2 := d.Nodes[1].VMs
	if len(vmOnN2) != 1 || vmOnN2[0].Status != "Migrating" || vmOnN2[0].MemoryMB != 16384 {
		t.Fatalf("VM status/memory should override VMI values: %+v", vmOnN2)
	}
}
