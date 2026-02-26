import "package:flutter_test/flutter_test.dart";

import "package:wateray_app/src/app.dart";

void main() {
  testWidgets("app boots with scaffold text", (tester) async {
    await tester.pumpWidget(const WaterayApp());

    expect(find.text("wateray scaffold ready"), findsOneWidget);
  });
}
