{
  "targets": [
    {
      "target_name": "pix_local_authority_windows",
      "sources": ["src/addon.c"],
      "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["advapi32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "WarningLevel": 4,
              "AdditionalOptions": ["/WX"],
              "ExceptionHandling": 0
            }
          }
        }]
      ]
    }
  ]
}
