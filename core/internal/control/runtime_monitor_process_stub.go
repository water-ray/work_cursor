//go:build !linux && !windows

package control

func enrichMonitorConnectionsProcessInfo(snapshot *clashConnectionsSnapshot) {
}
