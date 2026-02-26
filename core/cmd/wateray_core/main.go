//go:build cshared

package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"unsafe"

	"wateray/core/internal/ffi"
)

//export WaterayStartCore
func WaterayStartCore(configJSON *C.char) C.int {
	if configJSON == nil {
		return C.int(ffi.ErrInvalidConfig)
	}
	return C.int(ffi.StartCore(C.GoString(configJSON)))
}

//export WaterayReloadCore
func WaterayReloadCore(configJSON *C.char) C.int {
	if configJSON == nil {
		return C.int(ffi.ErrInvalidConfig)
	}
	return C.int(ffi.ReloadCore(C.GoString(configJSON)))
}

//export WaterayStopCore
func WaterayStopCore() C.int {
	return C.int(ffi.StopCore())
}

//export WaterayCoreVersion
func WaterayCoreVersion() *C.char {
	return C.CString(ffi.CoreVersion())
}

//export WaterayFreeString
func WaterayFreeString(ptr *C.char) {
	if ptr == nil {
		return
	}
	C.free(unsafe.Pointer(ptr))
}

func main() {}
