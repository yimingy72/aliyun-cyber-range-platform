import { TemplateEditorScreen } from '../../../../components/admin/template-editor/template-editor-screen';

type ScenarioEditorPageProps = {
  params: Promise<{ scenarioId: string }>;
};

export default async function ScenarioEditorPage({ params }: ScenarioEditorPageProps) {
  const { scenarioId } = await params;

  return <TemplateEditorScreen templateId={scenarioId} />;
}
