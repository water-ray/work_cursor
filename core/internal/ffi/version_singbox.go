//go:build sbcore

package ffi

import "github.com/sagernet/sing-box/constant"

func singBoxVersion() string {
	return constant.Version
}
