require('mini.pairs').setup {
  {
    mappings = {
      add = 'sa', -- Add surrounding in Normal and Visual modes
      delete = 'sd', -- Delete surrounding
      find = nil, -- Find surrounding (to the right)
      find_left = nil, -- Find surrounding (to the left)
      highlight = nil, -- Highlight surrounding
      replace = 'sr', -- Replace surrounding
      update_n_lines = nil, -- Update `n_lines`

      suffix_last = nil, -- Suffix to search with "prev" method
      suffix_next = nil, -- Suffix to search with "next" method
    },
  }
}
