//go:build !windows && !darwin

package control

func applySystemHTTPProxy(_ string, _ int) error {
	return nil
}

func clearSystemHTTPProxy() error {
	return nil
}
