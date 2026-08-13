"""Launch GLSim with the test-only Windows direct-runner compatibility shim."""

from gltest_windows_compat import install_glsim_direct_compatibility

install_glsim_direct_compatibility()

from glsim.__main__ import main


if __name__ == "__main__":
    main()
