using UnrealBuildTool;
using System.Collections.Generic;

public class {{identifier}}Target : TargetRules
{
	public {{identifier}}Target(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_6;
		ExtraModuleNames.Add("{{identifier}}");
	}
}
