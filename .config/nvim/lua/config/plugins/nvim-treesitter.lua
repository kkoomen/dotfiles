require('nvim-treesitter.configs').setup {
  -- Enable auto-tag for html files
  autotag = {
    enable = true,
    enable_rename = true,
    enable_close = true,
    enable_close_on_slash = true,
    filetypes = { "html" , "xml" },
  }
}
