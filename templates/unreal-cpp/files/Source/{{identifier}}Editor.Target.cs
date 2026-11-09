using UnrealBuildTool;
using System.Collections.Generic;

public class {{identifier}}EditorTarget : TargetRules
{
	public {{identifier}}EditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_6;
		ExtraModuleNames.Add("{{identifier}}");
	}
}
