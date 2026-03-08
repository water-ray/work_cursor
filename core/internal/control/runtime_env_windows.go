//go:build windows

package control

import "golang.org/x/sys/windows"

func detectRuntimeAdmin() bool {
	token := windows.Token(0)
	if token.IsElevated() {
		return true
	}
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return false
	}
	isMember, err := token.IsMember(adminSID)
	if err != nil {
		return false
	}
	return isMember
}
