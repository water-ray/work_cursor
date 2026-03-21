//go:build !darwin && !linux && !windows

package control

func enrichMonitorConnectionsProcessInfo(snapshot *clashConnectionsSnapshot) {
}
