package control

import "runtime"

type runtimeEnvironment struct {
	SystemType   string
	RuntimeAdmin bool
}

func detectRuntimeEnvironment() runtimeEnvironment {
	return runtimeEnvironment{
		SystemType:   runtime.GOOS,
		RuntimeAdmin: detectRuntimeAdmin(),
	}
}
