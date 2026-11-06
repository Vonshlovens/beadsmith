# The NVIDIA GPU is for compute (CUDA, local models); the Intel iGPU drives
# the display. The GPU is Pascal, which only the proprietary driver supports
# and which NVIDIA moved to its legacy branch, so the driver is pinned to
# the 580 series instead of following `stable`.
{ config, lib, ... }:
{
  hardware.graphics.enable = true;

  # The NVIDIA userspace and kernel module are unfree.
  nixpkgs.config.allowUnfreePredicate =
    pkg:
    builtins.elem (lib.getName pkg) [
      "nvidia-x11"
      "nvidia-settings"
      "nvidia-persistenced"
    ];

  # Needed even without an X server: it selects the kernel module.
  services.xserver.videoDrivers = [ "nvidia" ];

  hardware.nvidia = {
    package = config.boot.kernelPackages.nvidiaPackages.legacy_580;
    open = false; # Pascal has no open kernel module
    modesetting.enable = true;
    nvidiaSettings = false;
    # Render on the iGPU, run a program on the NVIDIA GPU only when asked
    # (`nvidia-offload <cmd>`). Bus ids are placeholders: read them from
    # `lspci | grep -E 'VGA|3D'` on the machine (01:00.0 becomes PCI:1:0:0).
    prime = {
      offload = {
        enable = true;
        enableOffloadCmd = true;
      };
      intelBusId = "PCI:0:2:0";
      nvidiaBusId = "PCI:1:0:0";
    };
  };
}
