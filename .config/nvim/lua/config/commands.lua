vim.cmd([[command! -nargs=0 BP :let @+=expand('%:p') | echo @*]])
vim.cmd([[command! -range=% PB <line1>,<line2>w !curl -s -F 'clbin=<-' https://clbin.com | tr -d '\n' | tee >(pbcopy) | cat]])
