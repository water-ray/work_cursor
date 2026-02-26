package ffi

/*
#include <stdint.h>
*/
import "C"

// StartCore starts core runtime with JSON config payload.
//
//export StartCore
func StartCore(configJSON *C.char) C.int {
	_ = configJSON
	return 0
}

// StopCore stops core runtime safely.
//
//export StopCore
func StopCore() C.int {
	return 0
}
