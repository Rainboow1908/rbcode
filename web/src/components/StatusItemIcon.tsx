import type { StatusItemId } from '../lib/types.ts'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BoxIcon,
  ClipboardListIcon,
  FolderIcon,
  GaugeIcon,
  LightbulbIcon,
  LoaderIcon,
  MessageSquareIcon,
  PermissionsIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
  TerminalIcon,
} from './icons.tsx'

/**
 * 状态栏每一项对应的图标。
 * 设置页的勾选列表和底部状态栏共用这一份，避免两边对不上。
 */
export default function StatusItemIcon({
  id,
  className,
}: {
  id: StatusItemId
  className?: string
}) {
  switch (id) {
    case 'project':
      return <FolderIcon className={className} />
    case 'backend':
      return <TerminalIcon className={className} />
    case 'model':
      return <BoxIcon className={className} />
    case 'permission':
      return <PermissionsIcon className={className} />
    case 'reasoning':
      return <LightbulbIcon className={className} />
    case 'cacheHit':
    case 'contextUsed':
    case 'contextTotal':
      return <GaugeIcon className={className} />
    case 'untilCompact':
    case 'compactThreshold':
      return <ArrowDownIcon className={className} />
    case 'speed':
      return <LoaderIcon className={className} />
    case 'outputTokens':
      return <ArrowUpIcon className={className} />
    case 'requests':
      return <PlayIcon className={className} />
    case 'rounds':
      return <RefreshIcon className={className} />
    case 'messages':
      return <MessageSquareIcon className={className} />
    case 'todos':
      return <ClipboardListIcon className={className} />
    case 'elapsed':
      return <StopIcon className={className} />
    case 'shells':
      return <TerminalIcon className={className} />
    default:
      return null
  }
}
