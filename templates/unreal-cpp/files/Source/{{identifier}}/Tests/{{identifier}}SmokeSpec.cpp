#include "Misc/AutomationTest.h"

// Test de humo: comprueba que el modulo compila y que Tools/test.ps1 ejecuta al menos un test.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(F{{identifier}}SmokeTest, "{{identifier}}.Smoke",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ProductFilter)

bool F{{identifier}}SmokeTest::RunTest(const FString& Parameters)
{
	TestTrue(TEXT("El modulo carga y el test corre"), true);
	return true;
}
