import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  useTable,
  tableFeatures,
  rowSortingFeature,
  rowPaginationFeature,
  createSortedRowModel,
  createPaginatedRowModel,
  sortFn_text,
  sortFn_alphanumeric,
  flexRender,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { SearchField } from './search-field'
import { Card, CardContent } from '@/components/ui/card'
import { Choice } from './selection'
import { Empty } from './shared'

const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { text: sortFn_text, alphanumeric: sortFn_alphanumeric },
})
function DataCell({ cell }) {
  const render = cell.column.columnDef.cell
  // 单元格渲染函数只负责生成内容，心跳刷新时保持按钮和菜单的组件身份。
  return typeof render === 'function'
    ? render(cell.getContext())
    : flexRender(render, cell.getContext())
}
export function DataTable({
  data,
  columns,
  searchText,
  searchPlaceholder = '搜索…',
  filters = [],
  filterValue,
  scopeNote,
  rowProps,
  renderExpanded,
  renderMobile,
  emptyTitle = '暂无记录',
  initialPageSize = 10,
}) {
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all')
  const filtered = useMemo(
    () =>
      data.filter(
        (item) =>
          (!search ||
            String(searchText?.(item) ?? '')
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (filter === 'all' || filterValue?.(item) === filter),
      ),
    [data, search, filter, searchText, filterValue],
  )
  const table = useTable({
    features,
    data: filtered,
    columns,
    initialState: { pagination: { pageIndex: 0, pageSize: initialPageSize } },
    getRowId: (row, i) => row.id || String(i),
  })
  const pagination = table.state.pagination
  useEffect(() => {
    table.setPageIndex(0)
  }, [search, filter])
  useEffect(() => {
    if (pagination.pageIndex >= table.getPageCount())
      table.setPageIndex(Math.max(0, table.getPageCount() - 1))
  }, [filtered.length, pagination.pageIndex])
  const rows = table.getRowModel().rows
  return (
    <div className="space-y-3" data-slot="data-table">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchField
          label={searchPlaceholder}
          placeholder={searchPlaceholder}
          value={search}
          onChange={setSearch}
          className="min-w-40 sm:max-w-72"
        />
        {!!filters.length && (
          <div className="w-36">
            <Choice
              aria-label="筛选状态"
              value={filter}
              onValueChange={setFilter}
              options={[{ value: 'all', label: '全部状态' }, ...filters]}
            />
          </div>
        )}
      </div>
      {!rows.length ? (
        <Empty
          title={search || filter !== 'all' ? '没有匹配的记录' : emptyTitle}
          description={search || filter !== 'all' ? '调整搜索内容或筛选条件后重试。' : undefined}
        />
      ) : (
        <>
          <div
            className={`overflow-hidden rounded-lg border ${renderMobile ? 'hidden md:block' : ''}`}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  {table.getAllLeafColumns().map((column) => (
                    <TableHead key={column.id} className={column.columnDef.meta?.className}>
                      {column.getCanSort() ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-2 h-8 gap-1 px-2 text-xs"
                          onClick={column.getToggleSortingHandler()}
                        >
                          {column.columnDef.header}
                          {column.getIsSorted() === 'asc' ? (
                            <ArrowUp className="size-3" />
                          ) : column.getIsSorted() === 'desc' ? (
                            <ArrowDown className="size-3" />
                          ) : (
                            <ArrowUpDown className="size-3 opacity-40" />
                          )}
                        </Button>
                      ) : (
                        column.columnDef.header
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <TableRow {...rowProps?.(row.original)}>
                      {row.getAllCells().map((cell) => (
                        <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                          <DataCell cell={cell} />
                        </TableCell>
                      ))}
                    </TableRow>
                    {renderExpanded?.(row.original) && (
                      <TableRow>
                        <TableCell colSpan={columns.length} className="bg-muted/25 p-4">
                          {renderExpanded(row.original)}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
          {renderMobile && (
            <div className="space-y-3 md:hidden">
              {rows.map((row) => (
                <Card key={row.id} className="py-4" {...rowProps?.(row.original)}>
                  <CardContent className="space-y-3 px-4">
                    {renderMobile(row.original)}
                    {renderExpanded?.(row.original)}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {scopeNote ? `${scopeNote} · ` : ''}匹配 {filtered.length} 条 / 已加载 {data.length} 条
        </span>
        {filtered.length > initialPageSize && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="上一页"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              <ChevronLeft />
            </Button>
            <span>
              第 {pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())} 页
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="下一页"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
