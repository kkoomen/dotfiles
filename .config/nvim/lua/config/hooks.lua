local function delete_trailing_leading_lines()
  -- Delete empty lines at the start of the buffer.
  if not string.find(vim.fn.getline(1), '%S') then
    vim.cmd([[keepjumps execute 'normal! gg"_dip']])
  end

  -- Delete empty lines at the end of the buffer.
  if not string.find(vim.fn.getline('$'), '%S') then
    vim.cmd([[keepjumps execute 'normal! G"_dip']])
  end
end

vim.api.nvim_create_autocmd('BufWritePre', {
  pattern = '*',
  callback = function()
    -- Save the current window view
    local winview = vim.fn.winsaveview()

    delete_trailing_leading_lines()

    -- Execute commands only for non-test files
    local ignore_pattern = [[\v(vader|gitcommit)]]
    if vim.bo.filetype ~= '' and not vim.fn.match(vim.bo.filetype, ignore_pattern) then
      -- Delete trailing whitespaces for each line
      vim.cmd([[keepjumps %s/\s\+$//ge]])

      -- We want to 'retab!' the whole file, but this will convert spaces to tabs
      -- inside comments when using tabs. To fix this, we will check if tabs are
      -- used, then convert everything to spaces and then convert the indentation
      -- to tabs.
      if vim.bo.expandtab == false then
        vim.bo.expandtab = true
        vim.cmd('keepjumps %retab!')
        vim.cmd('keepjumps %s/^\\s\\+/\\=string.rep("\\t", math.floor(#submatch(0) / vim.bo.shiftwidth)) .. string.rep(" ", #submatch(0) % vim.bo.shiftwidth)')
        vim.cmd('silent! noh')
        vim.bo.expandtab = false
      else
        vim.cmd('keepjumps %retab!')
      end
    end

    -- Restore the window view
    vim.fn.winrestview(winview)
  end
})

vim.api.nvim_create_autocmd('BufWritePre', {
  pattern = '*.{css,scss,less}',
  callback = function()
    -- Save the current window state
    local winview = vim.fn.winsaveview()

    -- Remove all lines with nothing but spaces
    vim.cmd('keepjumps g/^[\n[:space:]]*$/d _')

    -- Add lines in-between selector blocks
    vim.cmd('keepjumps %s/\\v(#.-)@<!([};])(.-%(//[^\n]*\\|/\\*.-\\*/[^\n]*)\\)\\?\\(_[^;{}]-{)@=/\\1\\2\\r/g')

    -- Add lines in-between closing bracket and variables
    vim.cmd('keepjumps %s/\\(}\\)\\(_[[:space:]]-\\$)@=/\\1\\r/g')

    -- Add lines in-between @import and other expressions starting with '@'
    vim.cmd('keepjumps %s/}\\n@\\([[:alpha:]]\\+\\)/}\\r\\r@\\1/g')

    -- Remove all extra lines between closing brackets
    vim.cmd('keepjumps g/}[}\\n[:space:]]*}/s/\\n^[\\n[:space:]]*$//g')

    -- Remove all extra lines
    vim.cmd('keepjumps %s/\\n\\{3,}/\\r\\r/g')

    -- Ensure every property is spaced correctly
    vim.cmd('keepjumps %s/^\\(\\s*[[:alnum:]-]\\+\\)\\s*:\\s*\\(_[^:]\\{-};\\)$/\\1: \\2/g')

    -- Ensure selectors and opening brackets are a single whitespace
    vim.cmd('keepjumps %s/\\v(#)@<!\\s*{/ {/g')

    delete_trailing_leading_lines()

    -- Restore the window view
    vim.fn.winrestview(winview)

    -- Remove search highlighting
    vim.cmd('silent! noh')
  end
})

vim.api.nvim_create_autocmd('BufWritePre', {
  pattern = '*.{c,h}',
  callback = function()
    local cursor_pos = vim.fn.getpos('.')

    -- Put all 'else if' on a new line
    vim.cmd('keepjumps %s/\\%(\\/\\/.*\\)\\@<!}\\s*else if\\s*(/\\="}\\n" .. string.rep(" ", vim.fn.indent(".")) .. "else if ("/g')

    -- Put all 'else' on a new line
    vim.cmd('keepjumps %s/\\%(\\/\\/.*\\)\\@<!}\\s*else/\\="}\\n" .. string.rep(" ", vim.fn.indent(".")) .. "else"/g')

    -- Put all 'do-while' on a new line
    vim.cmd('keepjumps %s/\\%(\\/\\/.*\\)\\@<!}\\s*while/\\="}\\n" .. string.rep(" ", vim.fn.indent(".")) .. "while"/g')

    -- Put all opening brackets on a newline
    vim.cmd('keepjumps %s/\\%(\\/\\/.*\\)\\@<!\\([^[:space:]]\\+\\)\\@<=\\s*{$/\\="\\n" .. string.rep(" ", vim.fn.indent(".")) .. "{"/g')

    -- Remove unnecessary white lines
    vim.cmd('keepjumps %s/\\n\\n\\n\\+/\\r\\r/g')

    vim.fn.setpos('.', cursor_pos)
  end
})

vim.api.nvim_create_autocmd('BufReadPost', {
  pattern = '*',
  callback = function()
    vim.api.nvim_exec('silent! normal! g`"zv', false)
  end
})
