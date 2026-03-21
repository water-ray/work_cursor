//go:build darwin

package control

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

const darwinNetworkSetupPath = "/usr/sbin/networksetup"

var darwinProxyBypassDomains = []string{"localhost", "127.0.0.1", "::1"}

func applySystemHTTPProxy(host string, port int) error {
	host = strings.TrimSpace(host)
	if host == "" || port <= 0 || port > 65535 {
		return errors.New("invalid system proxy host/port")
	}
	services, err := listEnabledDarwinNetworkServices()
	if err != nil {
		return err
	}
	portText := strconv.Itoa(port)
	commands := make([]darwinNetworkSetupCommand, 0, len(services)*4)
	for _, service := range services {
		commands = append(commands,
			darwinNetworkSetupCommand{
				context: fmt.Sprintf("设置 macOS Web 代理失败（%s）", service),
				args: []string{
					"-setwebproxy",
					service,
					host,
					portText,
				},
			},
			darwinNetworkSetupCommand{
				context: fmt.Sprintf("设置 macOS HTTPS 代理失败（%s）", service),
				args: []string{
					"-setsecurewebproxy",
					service,
					host,
					portText,
				},
			},
			darwinNetworkSetupCommand{
				context: fmt.Sprintf("设置 macOS SOCKS 代理失败（%s）", service),
				args: []string{
					"-setsocksfirewallproxy",
					service,
					host,
					portText,
				},
			},
		)
		args := append(
			[]string{
				"-setproxybypassdomains",
				service,
			},
			darwinProxyBypassDomains...,
		)
		commands = append(commands, darwinNetworkSetupCommand{
			context: fmt.Sprintf("设置 macOS 代理绕过域失败（%s）", service),
			args:    args,
		})
	}
	return runDarwinNetworkSetupCommands(commands)
}

func clearSystemHTTPProxy() error {
	services, err := listEnabledDarwinNetworkServices()
	if err != nil {
		return err
	}
	commands := make([]darwinNetworkSetupCommand, 0, len(services)*3)
	for _, service := range services {
		commands = append(commands,
			darwinNetworkSetupCommand{
				context: fmt.Sprintf("关闭 macOS Web 代理失败（%s）", service),
				args: []string{
					"-setwebproxystate",
					service,
					"off",
				},
			},
			darwinNetworkSetupCommand{
				context: fmt.Sprintf("关闭 macOS HTTPS 代理失败（%s）", service),
				args: []string{
					"-setsecurewebproxystate",
					service,
					"off",
				},
			},
			darwinNetworkSetupCommand{
				context: fmt.Sprintf("关闭 macOS SOCKS 代理失败（%s）", service),
				args: []string{
					"-setsocksfirewallproxystate",
					service,
					"off",
				},
			},
		)
	}
	return runDarwinNetworkSetupCommands(commands)
}

func listEnabledDarwinNetworkServices() ([]string, error) {
	output, err := exec.Command(darwinNetworkSetupPath, "-listallnetworkservices").CombinedOutput()
	if err != nil {
		return nil, formatDarwinNetworkSetupError("获取 macOS 网络服务列表失败", err, output)
	}
	services := parseDarwinNetworkServices(string(output))
	if len(services) == 0 {
		return nil, errors.New("未找到已启用的 macOS 网络服务")
	}
	return services, nil
}

func parseDarwinNetworkServices(raw string) []string {
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	services := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "An asterisk (*) denotes") {
			continue
		}
		if strings.HasPrefix(trimmed, "*") {
			continue
		}
		services = append(services, trimmed)
	}
	return services
}

type darwinNetworkSetupCommand struct {
	context string
	args    []string
}

func runDarwinNetworkSetupCommands(commands []darwinNetworkSetupCommand) error {
	if len(commands) == 0 {
		return nil
	}
	for _, command := range commands {
		if err := runDarwinNetworkSetupDirect(command.context, command.args...); err != nil {
			return runDarwinNetworkSetupWithPrivileges(commands, err)
		}
	}
	return nil
}

func runDarwinNetworkSetupDirect(context string, args ...string) error {
	output, err := exec.Command(darwinNetworkSetupPath, args...).CombinedOutput()
	if err != nil {
		return formatDarwinNetworkSetupError(context, err, output)
	}
	return nil
}

func runDarwinNetworkSetupWithPrivileges(
	commands []darwinNetworkSetupCommand,
	fallbackReason error,
) error {
	commandTexts := make([]string, 0, len(commands))
	for _, command := range commands {
		allArgs := append([]string{darwinNetworkSetupPath}, command.args...)
		commandTexts = append(commandTexts, buildDarwinShellCommand(allArgs))
	}
	script := fmt.Sprintf(
		"do shell script %q with administrator privileges",
		strings.Join(commandTexts, " && "),
	)
	output, err := exec.Command("osascript", "-e", script).CombinedOutput()
	if err != nil {
		return formatDarwinPrivilegedNetworkSetupError(err, output, fallbackReason)
	}
	return nil
}

func buildDarwinShellCommand(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		quoted = append(quoted, quoteDarwinShellArg(arg))
	}
	return strings.Join(quoted, " ")
}

func quoteDarwinShellArg(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func formatDarwinNetworkSetupError(context string, err error, output []byte) error {
	text := strings.TrimSpace(string(output))
	if text == "" {
		return fmt.Errorf("%s: %w", context, err)
	}
	return fmt.Errorf("%s: %s (%w)", context, text, err)
}

func formatDarwinPrivilegedNetworkSetupError(
	err error,
	output []byte,
	fallbackReason error,
) error {
	text := strings.TrimSpace(string(output))
	if strings.Contains(strings.ToLower(text), "user canceled") {
		return fmt.Errorf("macOS 系统代理授权已取消: %w", fallbackReason)
	}
	if text == "" {
		return fmt.Errorf("macOS 系统代理授权执行失败: %w", fallbackReason)
	}
	return fmt.Errorf("macOS 系统代理授权执行失败: %s (%w)", text, fallbackReason)
}
