//go:build windows

package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type memStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func memInfo() (totalMB, availMB int) {
	var m memStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")
	if r, _, _ := proc.Call(uintptr(unsafe.Pointer(&m))); r == 0 {
		return 0, 0
	}
	return int(m.TotalPhys / 1048576), int(m.AvailPhys / 1048576)
}

func diskFreeMB(path string) int {
	for p := path; p != ""; p = parentDir(p) {
		var free, total, totalFree uint64
		ptr, err := windows.UTF16PtrFromString(p)
		if err != nil {
			return 0
		}
		if windows.GetDiskFreeSpaceEx(ptr, &free, &total, &totalFree) == nil {
			return int(free / 1048576)
		}
		if parentDir(p) == p {
			break
		}
	}
	return 0
}

func virtualization() (bool, string) {
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessorFeaturePresent")
	// PF_VIRT_FIRMWARE_ENABLED = 21
	if r, _, _ := proc.Call(21); r != 0 {
		return true, "Hardware virtualization enabled in firmware"
	}
	return false, "Hardware virtualization not reported (only needed for the experimental microVM runtime)"
}

func isElevated() bool { return windows.GetCurrentProcessToken().IsElevated() }

func osName() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		return "Windows"
	}
	defer k.Close()
	name, _, _ := k.GetStringValue("ProductName")
	build, _, _ := k.GetStringValue("CurrentBuildNumber")
	return fmt.Sprintf("%s (build %s)", name, build)
}

func osFamily() string { return "windows" }
