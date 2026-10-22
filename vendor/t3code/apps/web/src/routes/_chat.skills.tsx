import { createFileRoute } from '@tanstack/react-router'
import { AutoOpsSkillLibraryPage } from '../autoops/SkillLibraryPage'

export const Route = createFileRoute('/_chat/skills')({ component: AutoOpsSkillLibraryPage })
