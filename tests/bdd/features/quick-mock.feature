Feature: Quick Mock method owner preparation

  Scenario: Method trace prepares MSRWattageReader before running the method
    Given a scanned graph with MSRWattageReader and its get_wattage method
    When I trace the get_wattage method
    Then the mock panel asks me to prepare MSRWattageReader with dll_path
    When I fill dll_path with "C:\tools\WinRing0x64.dll"
    And I run the prepare step
    Then the backend receives a class mock request for MSRWattageReader with dll_path "C:\tools\WinRing0x64.dll"
    When I run the method step
    Then the backend receives a method mock request for get_wattage using MSRWattageReader with dll_path "C:\tools\WinRing0x64.dll"

  Scenario: Untyped numeric mock input is coerced before Python execution
    Given a backend mock target with an untyped index parameter
    When I run the backend mock with index "0" as int
    Then the Python target receives integer index 0

  Scenario: Method mock can choose int for an untyped parameter
    Given a scanned graph with MSRWattageReader and its cpuid method
    When I trace the cpuid method
    And I run the prepare step
    And I choose bool for index
    Then index value uses a bool dropdown
    And I choose int for index and fill "0"
    And I run the method step
    Then the backend receives a method mock request for cpuid with index "0" as int

  Scenario: Backend mock supports package relative imports
    Given a backend mock target that imports a sibling module relatively
    When I run the backend mock target
    Then the Python target returns the relative import value

  Scenario: Backend mock can pass an imported strategy instance
    Given a backend mock target that accepts a strategy object
    When I run the backend mock with strategy "backend.strategies.FakeStrategy" as instance
    Then the Python target receives FakeStrategy instance
