import { TemplateEditorScreen } from '../../../../components/admin/template-editor/template-editor-screen';
import { resolveAdminApiBaseUrl } from '../../../../lib/admin-api-base-url';

type ScenarioEditorPageProps = {
  params: Promise<{ scenarioId: string }>;
};

export default async function ScenarioEditorPage({ params }: ScenarioEditorPageProps) {
  const { scenarioId } = await params;

  return <TemplateEditorScreen apiBaseUrl={resolveAdminApiBaseUrl()} templateId={scenarioId} />;
}
